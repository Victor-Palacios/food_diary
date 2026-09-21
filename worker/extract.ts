import { json, type Env } from './shared'

/**
 * Phase 2 -- nutrition extraction via the NVIDIA API.
 *
 * Three genuinely different features share this route, because they share the
 * plumbing and nothing else:
 *
 *   7a. label  -- read a printed nutrition panel. This is OCR over text, so
 *                 accuracy is high and it is the useful half.
 *   7b. plate  -- estimate an unlabelled plate of food from a photo. Accuracy
 *                 is poor and unknowable per meal, so every result is marked
 *                 as an estimate before it goes anywhere near the log.
 *   7c. text   -- estimate from a written description ("2 eggs and toast").
 *                 Same accuracy caveat as a plate, and the same estimate
 *                 flag, but it needs no camera and covers the restaurant
 *                 case, which is the most common unlabelled meal.
 *
 * All three are review-before-save. This endpoint returns a draft; the client
 * prefills a form with it and the user confirms. Nothing is ever written to
 * the log from here -- this Worker has no database credentials at all.
 */

/**
 * NVIDIA's vision endpoints take an inline base64 image only up to about
 * 180 KB. Over that the call does not fail cleanly -- it can hang until
 * Cloudflare's edge times out the whole request with a bare 524 -- so reject
 * it here with something the user can act on. The client compresses to fit,
 * and this is the backstop for when it cannot.
 */
const MAX_IMAGE_B64_BYTES = 180_000
const MAX_TEXT_CHARS = 600

/**
 * NVIDIA withdraws hosted models, and a withdrawn id answers 404/410 forever.
 * The live catalog is public and needs no key:
 *
 *   curl https://integrate.api.nvidia.com/v1/models
 *
 * Both of these are overridable by the vars of the same name in
 * wrangler.jsonc, so swapping a model is a config change, not a code change.
 */
const DEFAULT_VISION_MODEL = 'meta/llama-3.2-90b-vision-instruct'
const DEFAULT_TEXT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

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

const TEXT_PROMPT = `You are turning a short written description of a meal into
nutrition numbers, for someone logging what they ate.

There are TWO cases and you must tell them apart, because the answer is
recorded differently.

CASE A -- TRANSCRIBE. The description already states the nutrition, e.g.
"chicken bowl 630 cal, 45g protein, 60g carbs, 22g fat, 8g fiber". Copy those
numbers EXACTLY. Do not adjust, round, recalculate or second-guess them, even
if they look wrong to you. For any of the seven the text does not state, use 0
rather than inventing a value. Set "estimated": false.

CASE B -- ESTIMATE. The description names food but no calorie figure, e.g.
"2 eggs and toast with butter". Estimate the whole portion described. Set
"estimated": true.

If a calorie figure is stated but some macros are missing, that is still
CASE A: transcribe what is given, use 0 for the rest, and say in notes which
ones were absent.

The description may list several items in one meal. Combine them into ONE
total for the whole meal.

Return ONLY a JSON object, no prose, no markdown fence:
{
  "name": "short summary of the meal, e.g. \\"2 eggs, toast with butter, banana\\"",
  "serving_label": "the portion, e.g. \\"1 meal as described\\"",
  "estimated": true or false,
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_total_g": number,
    "fat_sat_g": number,
    "fat_trans_g": number,
    "fiber_g": number
  },
  "notes": "for CASE A, which values were absent from the text; for CASE B, what you assumed about portion sizes, brands and preparation"
}

Rules:
- Numbers only, no units, no ranges. Strip "g", "mg", "kcal", "cal".
- carbs_g is TOTAL carbohydrate, not net carbs.
- Where the description gives a quantity or a brand, respect it exactly.
- In CASE B, if a named restaurant dish has published nutrition data, use it
  and say so in notes -- but this is still an estimate, so "estimated": true.
- The user reviews and corrects every value before it is saved.`

interface ExtractRequest {
  kind?: unknown
  image?: unknown
  text?: unknown
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

  const kind =
    body.kind === 'label' || body.kind === 'plate' || body.kind === 'text'
      ? body.kind
      : null
  if (!kind) {
    return json({ error: 'kind must be "label", "plate" or "text".' }, 400)
  }

  // Text needs no image; the photo kinds need no text. Validate only what the
  // chosen kind actually uses, so a malformed field of the other sort cannot
  // reject an otherwise fine request.
  let description = ''
  let image = ''

  if (kind === 'text') {
    description = typeof body.text === 'string' ? body.text.trim() : ''
    if (!description) {
      return json({ error: 'Describe what you ate.' }, 400)
    }
    if (description.length > MAX_TEXT_CHARS) {
      return json(
        { error: `Keep the description under ${MAX_TEXT_CHARS} characters.` },
        413,
      )
    }
  } else {
    image = typeof body.image === 'string' ? body.image : ''
    if (!image.startsWith('data:image/')) {
      return json({ error: 'image must be a data: URL.' }, 400)
    }

    const payloadBytes = image.length - (image.indexOf(',') + 1)
    if (payloadBytes > MAX_IMAGE_B64_BYTES) {
      return json(
        {
          error:
            'That photo is too large for the model even after compression. ' +
            'Crop to just the label and try again.',
        },
        413,
      )
    }
  }

  const prompt =
    kind === 'label' ? LABEL_PROMPT : kind === 'plate' ? PLATE_PROMPT : TEXT_PROMPT

  // The description is passed as its own message part rather than spliced into
  // the prompt, so nothing a user types can be read as further instructions.
  const messageContent: Array<Record<string, unknown>> =
    kind === 'text'
      ? [
          { type: 'text', text: prompt },
          { type: 'text', text: `Description of the meal:\n${description}` },
        ]
      : [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image } },
        ]

  const baseUrl = env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'
  const visionModel = env.NVIDIA_MODEL || DEFAULT_VISION_MODEL

  // A text description does not need a vision model. Routing it to a
  // text-only model is cheaper and follows the transcribe-vs-estimate
  // instructions more reliably than the vision variant does.
  const model = kind === 'text' ? env.NVIDIA_TEXT_MODEL || DEFAULT_TEXT_MODEL : visionModel

  // Cloudflare's edge abandons the request at ~100s and hands the browser a
  // bare 524 with nothing useful in it. Give up first, so the user gets a
  // real message and a suggestion instead. Vision calls get longer because a
  // cold vision NIM genuinely can take most of a minute.
  const timeoutMs = kind === 'text' ? 40_000 : 70_000

  let result = await callModel(env, baseUrl, model, messageContent, timeoutMs, kind)

  // NVIDIA retires hosted models, and a retired id answers 404/410 forever.
  // Rather than leave the feature dead until someone notices, fall back to
  // the vision model, which handles plain text perfectly well. Costs a little
  // more per call; beats being broken.
  if (result.retired && kind === 'text' && model !== visionModel) {
    console.error(
      `NVIDIA_TEXT_MODEL "${model}" is retired (${result.status}); ` +
        `falling back to "${visionModel}". Update the var to silence this.`,
    )
    result = await callModel(env, baseUrl, visionModel, messageContent, timeoutMs, kind)
  }

  if (result.error) return result.error

  const parsed = parseJsonObject(result.content ?? '')
  if (!parsed) {
    return json(
      {
        error:
          kind === 'text'
            ? 'Could not read a result from that description. Enter it by hand.'
            : 'Could not read a result from that photo. Enter it by hand.',
      },
      422,
    )
  }

  return json(parsed)
}

interface CallResult {
  content?: string
  /** Set when the model id itself is gone, so the caller can try another. */
  retired?: boolean
  status?: number
  error?: Response
}

async function callModel(
  env: Env,
  baseUrl: string,
  model: string,
  messageContent: Array<Record<string, unknown>>,
  timeoutMs: number,
  kind: string,
): Promise<CallResult> {
  const startedAt = Date.now()

  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: messageContent }],
        // Low temperature: this is a transcription task for labels and a
        // point estimate for plates. Neither wants creativity.
        temperature: 0.1,
        top_p: 0.9,
        max_tokens: 700,
        stream: false,
      }),
    })
  } catch (e) {
    const elapsed = Date.now() - startedAt
    const timedOut =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

    console.error(`NVIDIA ${kind} via ${model} failed after ${elapsed}ms: ${errorText(e)}`)

    if (timedOut) {
      return {
        error: json(
          {
            error:
              `The model did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
              `It may be busy — try again, or type the numbers in by hand.`,
          },
          504,
        ),
      }
    }
    return {
      error: json(
        { error: `Could not reach the extraction service: ${errorText(e)}` },
        502,
      ),
    }
  }

  console.log(
    `NVIDIA ${kind} via ${model}: ${upstream.status} in ${Date.now() - startedAt}ms`,
  )

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300)
    console.error(`NVIDIA ${upstream.status} for "${model}": ${detail}`)

    // 404/410 mean the id is wrong or withdrawn -- a configuration problem,
    // not a transient one, so name it instead of saying "try again".
    if (upstream.status === 404 || upstream.status === 410) {
      return {
        retired: true,
        status: upstream.status,
        error: json(
          {
            error:
              `The model "${model}" is no longer available (${upstream.status}). ` +
              `Point NVIDIA_${kind === 'text' ? 'TEXT_' : ''}MODEL at a current one ` +
              `from https://integrate.api.nvidia.com/v1/models`,
          },
          502,
        ),
      }
    }

    if (upstream.status === 401 || upstream.status === 403) {
      return {
        error: json(
          { error: 'The NVIDIA API key was rejected. Check or rotate NVIDIA_API_KEY.' },
          502,
        ),
      }
    }

    return {
      error: json(
        { error: `The extraction service returned ${upstream.status}.` },
        upstream.status === 429 ? 429 : 502,
      ),
    }
  }

  const payload = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>
  } | null

  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return {
      error: json({ error: 'The extraction service returned nothing usable.' }, 502),
    }
  }

  return { content }
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
