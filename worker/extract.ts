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
 * Both ids were chosen by probing the API with this key (GET /api/diag), not
 * by reading the catalog. Presence in the public /v1/models list is NOT
 * availability: several plausible ids return 404, and the 90B vision model
 * -- the obvious choice, and the one configured first -- never responds at
 * all. The 11B vision model answers a real image in under 400ms.
 *
 * Both are overridable by the vars of the same name in wrangler.jsonc, so
 * swapping a model is a config change, not a code change. Re-run /api/diag
 * if either starts failing.
 */
const DEFAULT_VISION_MODEL = 'meta/llama-3.2-11b-vision-instruct'

/**
 * Chosen by probing the API (/api/diag), not by reading the catalog.
 *
 * Being listed in /v1/models does not mean a model is callable with a given
 * key: two plausible Nemotron ids return 404, and the 90B vision model does
 * not respond at all. This one answers in roughly 350ms.
 */
const DEFAULT_TEXT_MODEL = 'google/gemma-4-31b-it'

/**
 * Total wall-clock budget for the upstream work, shared across a retry.
 *
 * This can exceed Cloudflare's ~100s edge timeout only because the reply is
 * streamed with heartbeats (see streamWhileWorking); a request that sits
 * silent gets killed at 100s no matter what this says.
 */
const TOTAL_BUDGET_MS = 300_000

/**
 * Budget for a reply that is NOT streamed, and so has no heartbeats keeping
 * it alive. Cloudflare's edge abandons a silent request near 100s, so this
 * must finish before that or the browser gets a bare 524 instead of an
 * error it can act on. Only a client cached from before streaming existed
 * takes this path.
 */
const BUFFERED_BUDGET_MS = 85_000

/** Frequent enough that no intermediary sees an idle connection. */
const HEARTBEAT_MS = 10_000

/** No point starting a call that cannot plausibly finish. */
const MIN_ATTEMPT_MS = 8_000

/**
 * When to fire a second, identical request alongside a slow first one.
 *
 * Measured against the live API, the same input returns in about 4-9s
 * seven times out of eight -- and then once takes 70-90s. That spread is
 * queueing, not work: the slow call is waiting for capacity, not thinking
 * harder. A duplicate request usually lands on a free worker and answers in
 * the normal few seconds, so racing the two cuts the tail without changing
 * the typical case.
 *
 * The cost is one extra call on the minority of requests that are slow. At a
 * handful of meals a day that is negligible, and a 70s wait on a phone is
 * not.
 */
const HEDGE_AFTER_MS = 15_000

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
  "name": "what the food is called",
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
- If the description names the dish, use that name as written. Do not
  shorten it, paraphrase it, or replace it with a generic description.
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

  // Everything above this point fails fast and gets an ordinary status code.
  // From here the model call can take minutes, so the reply is streamed --
  // see streamWhileWorking for why.
  const work = (budgetMs: number) =>
    runExtraction(env, baseUrl, model, visionModel, messageContent, kind, budgetMs).then(
      (final) =>
        kind === 'text' && final.ok
          ? { ...final, result: applyStatedValues(final.result, description) }
          : final,
    )

  // Only stream to a client that asked for it. One cached from before
  // streaming existed would parse newline-delimited output as JSON, fail,
  // and silently show an empty form; it gets a buffered reply instead.
  //
  // A buffered reply sends no heartbeats, so it must also finish inside the
  // edge's ~100s window -- the long budget is only safe behind a stream.
  // Running old code therefore costs the extra time, not correctness.
  if (!(request.headers.get('accept') ?? '').includes('ndjson')) {
    const final = await work(BUFFERED_BUDGET_MS)
    return final.ok
      ? json(final.result)
      : json({ error: final.error, detail: final.detail }, 502)
  }

  return streamWhileWorking(() => work(TOTAL_BUDGET_MS))
}

/**
 * Overwrites the model's numbers with any the user stated outright, and
 * settles the estimate flag from the text rather than the model's opinion.
 *
 * A figure the user typed is ground truth. The model's job on that input is
 * transcription, and transcription is something we can simply do ourselves,
 * so a misread digit or an unhelpfully rounded one cannot reach the log.
 */
function applyStatedValues(
  result: Record<string, unknown>,
  description: string,
): Record<string, unknown> {
  const stated = readStatedValues(description)
  const keys = Object.keys(stated) as Array<keyof StatedValues>
  if (keys.length === 0) return result

  const nutrition = { ...((result.nutrition ?? {}) as Record<string, unknown>) }
  for (const key of keys) nutrition[key] = stated[key]

  const transcribed = isTranscription(stated)
  if (transcribed && result.estimated !== false) {
    console.log(
      `Overriding estimated=${String(result.estimated)} -> false: ` +
        `the description states ${keys.join(', ')}.`,
    )
  }

  return {
    ...result,
    nutrition,
    // Only ever downgrade to "not an estimate" on evidence. If the figures
    // are absent the model's own judgement stands.
    estimated: transcribed ? false : result.estimated,
  }
}

/** The single line the client ultimately reads off the stream. */
type Final =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; detail?: string }

async function runExtraction(
  env: Env,
  baseUrl: string,
  model: string,
  visionModel: string,
  messageContent: Array<Record<string, unknown>>,
  kind: string,
  budgetMs: number,
): Promise<Final> {
  // One shared deadline rather than a per-call timeout, so a fast failure
  // followed by a retry cannot add up to more than the whole budget.
  const deadline = Date.now() + budgetMs

  let result = await callModel(env, baseUrl, model, messageContent, deadline, kind)

  // NVIDIA retires hosted models, and a retired id answers 404/410 forever.
  // Rather than leave the feature dead until someone notices, fall back to
  // the vision model, which handles plain text perfectly well. Costs a little
  // more per call; beats being broken.
  if (
    result.retired &&
    kind === 'text' &&
    model !== visionModel &&
    deadline - Date.now() > MIN_ATTEMPT_MS
  ) {
    console.error(
      `NVIDIA_TEXT_MODEL "${model}" is retired (${result.status}); ` +
        `falling back to "${visionModel}". Update the var to silence this.`,
    )
    result = await callModel(env, baseUrl, visionModel, messageContent, deadline, kind)
  }

  if (result.failure) return { ok: false, ...result.failure }

  const parsed = parseJsonObject(result.content ?? '')
  if (!parsed) {
    // Log the whole reply: when this fires, the reply is the only evidence
    // of why, and guessing at it costs far more than the log line.
    console.error(
      `Unparseable ${kind} reply from ${model} ` +
        `(${result.content?.length ?? 0} chars): ${(result.content ?? '').slice(0, 1500)}`,
    )
    return {
      ok: false,
      error:
        kind === 'text'
          ? 'Could not read a result from that description. Enter it by hand.'
          : 'Could not read a result from that photo. Enter it by hand.',
      // Echoed back so a failure can be diagnosed from the phone rather
      // than by digging through Worker logs. It is the user's own content
      // coming back, so nothing is disclosed that they did not send.
      detail: (result.content ?? '').slice(0, 300),
    }
  }

  return { ok: true, result: parsed }
}

/**
 * Streams the reply instead of awaiting it and answering in one go.
 *
 * Cloudflare's edge abandons a request that has produced no bytes for around
 * 100 seconds and returns a bare 524 -- so simply raising the Worker's own
 * timeout past that buys nothing, it only replaces a useful error message
 * with an opaque one. A response that keeps emitting bytes is not idle, so
 * heartbeats let the model take as long as the budget allows.
 *
 * The format is newline-delimited: lines beginning with ':' are heartbeats to
 * ignore, and the last line is the result. Because the status code is sent
 * with the headers, long before the outcome is known, it is always 200 and
 * failures are carried in the body as { ok: false }.
 */
function streamWhileWorking(work: () => Promise<Final>): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream({
    async start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':\n'))
        } catch {
          // Client hung up; the interval is cleared below.
        }
      }, HEARTBEAT_MS)

      // Send one immediately so the response headers flush right away.
      controller.enqueue(encoder.encode(':\n'))

      let final: Final
      try {
        final = await work()
      } catch (e) {
        console.error(`Extraction threw: ${errorText(e)}`)
        final = { ok: false, error: `Extraction failed: ${errorText(e)}` }
      }

      clearInterval(beat)
      try {
        controller.enqueue(encoder.encode(`${JSON.stringify(final)}\n`))
      } catch {
        // Nothing to do if the client has gone.
      }
      controller.close()
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Stop any intermediary buffering the heartbeats, which would defeat
      // the entire point of sending them.
      'x-accel-buffering': 'no',
    },
  })
}

interface CallResult {
  content?: string
  /** Set when the model id itself is gone, so the caller can try another. */
  retired?: boolean
  status?: number
  failure?: { error: string; detail?: string }
}

async function callModel(
  env: Env,
  baseUrl: string,
  model: string,
  messageContent: Array<Record<string, unknown>>,
  deadline: number,
  kind: string,
): Promise<CallResult> {
  const startedAt = Date.now()
  const timeoutMs = Math.max(MIN_ATTEMPT_MS, deadline - startedAt)

  const requestBody = JSON.stringify({
    model,
    messages: [{ role: 'user', content: messageContent }],
    // Low temperature: this is a transcription task for labels and a
    // point estimate for plates. Neither wants creativity.
    temperature: 0.1,
    top_p: 0.9,
    // Generous: the JSON is short, but a model that narrates before
    // answering would otherwise be cut off mid-object, and a truncated
    // reply is indistinguishable from a broken one.
    max_tokens: 1500,
    stream: false,
  })

  const send = (signal: AbortSignal): Promise<Response> =>
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: requestBody,
    })

  let upstream: Response
  try {
    upstream = await hedge(send, timeoutMs, model, kind)
  } catch (e) {
    const elapsed = Date.now() - startedAt
    const timedOut =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

    console.error(`NVIDIA ${kind} via ${model} failed after ${elapsed}ms: ${errorText(e)}`)

    if (timedOut) {
      return {
        failure: {
          // Name the model: if this keeps happening it is a model choice
          // problem, not a transient one, and the var is one edit away.
          error:
            `"${model}" did not answer within ${Math.round(elapsed / 1000)}s. ` +
            `It may be queued or cold — try again, or type the numbers in by hand.`,
        },
      }
    }
    return {
      failure: { error: `Could not reach the extraction service: ${errorText(e)}` },
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
        failure: {
          error:
            `The model "${model}" is no longer available (${upstream.status}). ` +
            `Point NVIDIA_${kind === 'text' ? 'TEXT_' : ''}MODEL at a current one ` +
            `from https://integrate.api.nvidia.com/v1/models`,
        },
      }
    }

    if (upstream.status === 401 || upstream.status === 403) {
      return {
        failure: {
          error: 'The NVIDIA API key was rejected. Check or rotate NVIDIA_API_KEY.',
        },
      }
    }

    return {
      failure: { error: `The extraction service returned ${upstream.status}.` },
    }
  }

  const payload = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>
  } | null

  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return {
      failure: { error: 'The extraction service returned nothing usable.' },
    }
  }

  return { content }
}

/**
 * Recovers the JSON object from a model reply.
 *
 * A model is not a parser, and this has to cope with everything they
 * actually do: wrap the object in prose, fence it as markdown, narrate
 * inside <think> tags first, or run out of tokens halfway through. Failing
 * on any of those means telling the user "could not read a result" when the
 * numbers were right there, so each case is handled rather than rejected.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let candidate = stripReasoning(text)

  // Prefer a fenced block when there is one; models put the answer there.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate)
  if (fenced) {
    const fromFence = extractObject(fenced[1])
    if (fromFence) return fromFence
  }

  // An unterminated fence means the reply was cut off inside it.
  const openFence = /```(?:json)?\s*([\s\S]*)$/i.exec(candidate)
  if (openFence) candidate = openFence[1]

  return extractObject(candidate)
}

/** Drops <think> narration, closed or left hanging by a truncated reply. */
function stripReasoning(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
  const dangling = closed.search(/<think>/i)
  // Text after an unclosed <think> is narration that never reached an answer,
  // but anything before it may still hold one.
  return dangling === -1 ? closed : closed.slice(0, dangling)
}

function extractObject(candidate: string): Record<string, unknown> | null {
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
      if (depth === 0) return tryParse(candidate.slice(start, i + 1))
    }
  }

  // Never balanced, so the reply was truncated. Close what is still open and
  // salvage it: a partial object still carries most of the seven values, and
  // the client defaults anything missing to 0 for the user to correct. Half a
  // filled form beats an error message.
  if (depth > 0) {
    let repaired = candidate.slice(start)
    if (inString) repaired += '"'
    // Drop a key with no value, then any trailing comma, before closing.
    repaired = repaired.replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/,\s*$/, '')
    repaired += '}'.repeat(depth)
    return tryParse(repaired)
  }

  return null
}

/**
 * Pulls nutrition figures the user stated outright from their own text.
 *
 * Whether a description was transcribed or estimated is far too important to
 * leave to the model's self-report: it decides `is_estimate`, and a wrongly
 * flagged entry is real data that looks like a guess. Models were observed
 * marking "630 cal, 45g protein, ..." as an estimate, so the question is
 * settled here instead, from the text the user actually typed.
 *
 * Handles both orders people write in -- "47g protein" and "Protein: 47g".
 */
const METRIC_WORDS: Array<[keyof StatedValues, string]> = [
  // Longest and most specific first: "saturated fat" must not be read as
  // plain "fat", and "total fat" must not be read as "sat fat".
  ['fat_sat_g', 'saturated fat|sat\\.? ?fat'],
  ['fat_trans_g', 'trans ?fat'],
  ['fiber_g', 'fibre|fiber'],
  ['protein_g', 'protein'],
  ['carbs_g', 'carbohydrates?|carbs?'],
  ['fat_total_g', 'total fat|fat'],
  ['calories', 'calories|kcals?|cals?'],
]

export interface StatedValues {
  calories?: number
  protein_g?: number
  carbs_g?: number
  fat_total_g?: number
  fat_sat_g?: number
  fat_trans_g?: number
  fiber_g?: number
}

export function readStatedValues(text: string): StatedValues {
  const found: StatedValues = {}
  let remaining = ` ${text} `

  for (const [key, words] of METRIC_WORDS) {
    // "47 g protein" / "47g of protein"
    const before = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:g|grams?|kcals?|cals?)?\\s*(?:of\\s+)?(?:${words})\\b`, 'i')
    // "protein: 47g" / "protein 47 g"
    const after = new RegExp(`\\b(?:${words})\\b\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)`, 'i')

    const m = before.exec(remaining) ?? after.exec(remaining)
    if (!m) continue

    const value = Number(m[1])
    if (!Number.isFinite(value) || value < 0) continue

    found[key] = value
    // Consume the match so "fat" cannot later re-match inside "saturated fat".
    remaining = remaining.replace(m[0], ' '.repeat(m[0].length))
  }

  return found
}

/**
 * True when the user supplied the figures that matter, so the entry is a
 * transcription rather than a guess. Saturated and trans fat are excluded:
 * labels routinely omit them and their absence should not demote an
 * otherwise exact entry to an estimate.
 */
export function isTranscription(stated: StatedValues): boolean {
  return (
    stated.calories !== undefined &&
    stated.protein_g !== undefined &&
    stated.carbs_g !== undefined &&
    stated.fat_total_g !== undefined
  )
}

/**
 * Sends the request, and if it has not answered within HEDGE_AFTER_MS sends
 * a second identical one, returning whichever replies first and cancelling
 * the other. Both share the overall timeout.
 */
async function hedge(
  send: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  model: string,
  kind: string,
): Promise<Response> {
  // Each attempt carries its own controller so the LOSER can be cancelled
  // without touching the winner -- aborting the winner would tear down the
  // response before its body is read.
  interface Attempt {
    controller: AbortController
    promise: Promise<Response>
  }

  const start = (): Attempt => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('TimeoutError')), timeoutMs)
    const promise = send(controller.signal).finally(() => clearTimeout(timer))
    // Nothing may be listening if this one loses the race; without a no-op
    // handler that becomes an unhandled rejection.
    promise.catch(() => {})
    return { controller, promise }
  }

  const first = start()

  // Nothing to hedge against if the budget is nearly spent anyway.
  if (timeoutMs <= HEDGE_AFTER_MS + MIN_ATTEMPT_MS) return first.promise

  const HEDGE = Symbol('hedge')
  const raced = await Promise.race([
    first.promise.then((r) => ({ ok: r })).catch((e: unknown) => ({ err: e })),
    new Promise<typeof HEDGE>((resolve) => setTimeout(() => resolve(HEDGE), HEDGE_AFTER_MS)),
  ])

  if (raced !== HEDGE) {
    if ('ok' in raced) return raced.ok
    throw raced.err
  }

  console.log(`NVIDIA ${kind} via ${model}: slow past ${HEDGE_AFTER_MS}ms, hedging`)
  const second = start()

  // Tag each attempt so the winner is identifiable and only the other one
  // gets cancelled. Promise.any resolves on the first SUCCESS, so a single
  // failing attempt does not sink the other.
  const tagged = [first, second].map((a) =>
    a.promise.then((response) => ({ response, attempt: a })),
  )

  try {
    const winner = await Promise.any(tagged)
    for (const a of [first, second]) if (a !== winner.attempt) a.controller.abort()
    return winner.response
  } catch (e) {
    first.controller.abort()
    second.controller.abort()
    throw e instanceof AggregateError ? (e.errors[0] ?? e) : e
  }
}

function tryParse(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(source)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
