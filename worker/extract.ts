import { json, type Env } from './shared'

/**
 * Phase 2 -- photo extraction via the NVIDIA API.
 *
 * Two genuinely different features share this route, because they share the
 * plumbing and nothing else:
 *
 *   7a. label  -- read a printed nutrition panel. This is OCR over text, so
 *                 accuracy is high and it is the useful half.
 *   7b. plate  -- estimate an unlabelled plate of food. Accuracy is poor and
 *                 unknowable per meal, so every result is marked as an
 *                 estimate before it goes anywhere near the log.
 *
 * Both are review-before-save. This endpoint returns a draft; the client
 * prefills a form with it and the user confirms. Nothing is ever written to
 * the log from here -- this Worker has no database credentials at all.
 */

const MAX_IMAGE_BYTES = 6 * 1024 * 1024

const LABEL_PROMPT = `You are reading a printed nutrition facts panel from a photograph.

Extract the values for ONE SERVING as printed on the label. If the label shows
both "per serving" and "per container" columns, use the PER SERVING column.

Return ONLY a JSON object, no prose, no markdown fence:
{
  "name": "product name as printed, including flavour if shown",
  "serving_label": "the serving size exactly as printed, e.g. \\"1 scoop (32 g)\\"",
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_total_g": number,
    "fat_sat_g": number,
    "fat_trans_g": number,
    "fiber_g": number
  },
  "notes": "anything ambiguous or unreadable, one short sentence, or empty string"
}

Rules:
- Use 0 for any value the label does not print. Never guess a printed value.
- Numbers only, no units, no ranges. Strip "g", "mg", "kcal".
- carbs_g is TOTAL carbohydrate, not net carbs.
- If you cannot read the panel at all, return every nutrition value as 0 and
  say so in notes.`

const PLATE_PROMPT = `You are estimating the nutrition of a plate of food from a photograph.
There is no label and no scale reading. This is an estimate and it will be
recorded as one.

Identify the dish and estimate the nutrition of the WHOLE PORTION SHOWN.

Return ONLY a JSON object, no prose, no markdown fence:
{
  "name": "short dish description, e.g. \\"Chicken burrito with rice and beans\\"",
  "serving_label": "the portion you estimated, e.g. \\"1 plate as shown\\"",
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_total_g": number,
    "fat_sat_g": number,
    "fat_trans_g": number,
    "fiber_g": number
  },
  "notes": "what you assumed about portion size and preparation, one or two short sentences"
}

Rules:
- Estimate the portion actually visible, not a standard restaurant serving.
- Numbers only, no units, no ranges. Give your single best estimate.
- Say in notes what you were unsure about. The user reviews every value before
  it is saved.`

interface ExtractRequest {
  kind?: unknown
  image?: unknown
}

export async function handleExtract(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405)
  }

  // 501 is the signal the client uses to hide the photo buttons entirely.
  // Phase 2 is optional by design; an unconfigured deployment is a valid one.
  if (!env.NVIDIA_API_KEY) {
    return json(
      { error: 'Photo extraction is not configured on this deployment.' },
      501,
    )
  }

  let body: ExtractRequest
  try {
    body = (await request.json()) as ExtractRequest
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }

  const kind = body.kind === 'label' || body.kind === 'plate' ? body.kind : null
  if (!kind) {
    return json({ error: 'kind must be "label" or "plate".' }, 400)
  }

  const image = typeof body.image === 'string' ? body.image : ''
  if (!image.startsWith('data:image/')) {
    return json({ error: 'image must be a data: URL.' }, 400)
  }
  if (image.length > MAX_IMAGE_BYTES) {
    return json({ error: 'That photo is too large. Try again with less zoom.' }, 413)
  }

  const baseUrl = env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'
  const model = env.NVIDIA_MODEL || 'meta/llama-3.2-90b-vision-instruct'

  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: kind === 'label' ? LABEL_PROMPT : PLATE_PROMPT },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        // Low temperature: this is a transcription task for labels and a
        // point estimate for plates. Neither wants creativity.
        temperature: 0.1,
        top_p: 0.9,
        max_tokens: 700,
        stream: false,
      }),
    })
  } catch (e) {
    return json(
      { error: `Could not reach the extraction service: ${errorText(e)}` },
      502,
    )
  }

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 400)
    // The upstream body can echo request details, so it is logged rather than
    // returned verbatim; the client gets the status only.
    console.error(`NVIDIA API ${upstream.status}: ${detail}`)
    return json(
      { error: `The extraction service returned ${upstream.status}.` },
      upstream.status === 429 ? 429 : 502,
    )
  }

  const payload = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>
  } | null

  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return json({ error: 'The extraction service returned nothing usable.' }, 502)
  }

  const parsed = parseJsonObject(content)
  if (!parsed) {
    return json(
      { error: 'Could not read a result from that photo. Enter it by hand.' },
      422,
    )
  }

  return json(parsed)
}

/**
 * Models wrap JSON in prose or a markdown fence often enough that a bare
 * JSON.parse is not worth relying on. Take the outermost balanced object.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced ? fenced[1] : text

  const start = candidate.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const value: unknown = JSON.parse(candidate.slice(start, i + 1))
          return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null
        } catch {
          return null
        }
      }
    }
  }

  return null
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
