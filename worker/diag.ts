import { json, type Env } from './shared'
import { NVIDIA_VISION_MODELS, WORKERS_AI_MODELS, modelChain } from './models'
import { LABEL_PROMPT, callModel, callWorkersAi, parseJsonObject, parseLooseReply } from './extract'

/**
 * Probes candidate models so a broken one can be identified in a single
 * round trip instead of a deploy per guess.
 *
 * NVIDIA's public catalog lists models that are not necessarily callable
 * with a given key, and a wrong id answers 404/410 -- which is how text
 * requests silently ended up on the slow vision model via the fallback.
 * Listing is not the same as working, so this asks each one directly.
 *
 * Deliberately tiny: five output tokens and a short timeout per model, run
 * sequentially. It is a diagnostic, not a feature, and can be deleted once
 * the model choice is settled.
 */
/**
 * Catalog models worth probing that are not in a chain yet. The chains
 * themselves (models.ts) are always probed, so this list is only for
 * scouting replacements.
 */
const EXTRA_VISION_CANDIDATES = ['moonshotai/kimi-k2.6', 'google/gemma-4-31b-it', 'nvidia/cosmos-reason2-8b']
const EXTRA_TEXT_CANDIDATES = ['deepseek-ai/deepseek-v4.1-flash']

const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC'

const PER_MODEL_TIMEOUT_MS = 20_000

export async function handleDiag(request: Request, env: Env): Promise<Response> {
  if (!env.NVIDIA_API_KEY && !env.AI) return json({ error: 'No model provider configured.' }, 501)
  if (request.method === 'POST') return probeWithLabel(request, env)

  const baseUrl = env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'
  const nvidia = (kind: 'plate' | 'text', extra: string[]) => [
    ...modelChain(env, kind).filter((p) => p.via === 'nvidia').map((p) => p.model),
    ...extra,
  ]
  const unique = (xs: string[]) => [...new Set(xs)]

  return json({
    photoChain: modelChain(env, 'plate').map((p) => p.model),
    textChain: modelChain(env, 'text').map((p) => p.model),
    vision: env.NVIDIA_API_KEY ? await probe(env, baseUrl, unique(nvidia('plate', EXTRA_VISION_CANDIDATES)), true) : [],
    text: env.NVIDIA_API_KEY ? await probe(env, baseUrl, unique(nvidia('text', EXTRA_TEXT_CANDIDATES)).filter((m) => !NVIDIA_VISION_MODELS.includes(m)), false) : [],
    workersAi: env.AI ? await probeWorkersAi(env) : 'no AI binding',
  })
}

/** Each keyless Workers AI model, given the same tiny image. */
async function probeWorkersAi(env: Env): Promise<Array<Record<string, unknown>>> {
  const ai = env.AI as unknown as { run(model: string, input: unknown): Promise<{ response?: unknown }> }
  const results: Array<Record<string, unknown>> = []
  for (const model of WORKERS_AI_MODELS) {
    const startedAt = Date.now()
    try {
      const out = await Promise.race([
        ai.run(model, {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What colour is this image? One word.' },
                { type: 'image_url', image_url: { url: TEST_IMAGE } },
              ],
            },
          ],
          max_tokens: 5,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PER_MODEL_TIMEOUT_MS)),
      ])
      results.push({ model, status: 'ok', ms: Date.now() - startedAt, reply: String(out?.response ?? '').slice(0, 40) })
    } catch (e) {
      results.push({ model, status: 'error', ms: Date.now() - startedAt, reply: e instanceof Error ? e.message.slice(0, 160) : String(e) })
    }
  }
  return results
}

async function probe(
  env: Env,
  baseUrl: string,
  models: string[],
  withImage: boolean,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = []

  for (const model of models) {
    const startedAt = Date.now()
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: withImage
                ? [
                    { type: 'text', text: 'What colour is this image? One word.' },
                    { type: 'image_url', image_url: { url: TEST_IMAGE } },
                  ]
                : 'Reply with the single word: ok',
            },
          ],
          max_tokens: 5,
          temperature: 0,
          stream: false,
        }),
      })
      const ms = Date.now() - startedAt
      const text = await r.text()
      let reply: string | undefined
      try {
        reply = JSON.parse(text)?.choices?.[0]?.message?.content?.slice(0, 40)
      } catch {
        reply = text.slice(0, 120)
      }
      results.push({ model, status: r.status, ms, reply })
    } catch (e) {
      results.push({
        model,
        status: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'error',
        ms: Date.now() - startedAt,
        reply: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return results
}

/**
 * POST a real label photo ({ "image": "data:image/jpeg;base64,..." }) and
 * every model in the photo chain reads it with the app's own label prompt,
 * all at once. Reports how long each took and what it read, which is what
 * the chain order should be chosen on: speed alone says nothing about
 * whether a model reads 7 g as 7.
 */
async function probeWithLabel(request: Request, env: Env): Promise<Response> {
  let image = ''
  try {
    image = String(((await request.json()) as { image?: unknown }).image ?? '')
  } catch {
    // Falls through to the check below.
  }
  if (!image.startsWith('data:image/') || image.length > 200_000) {
    return json({ error: 'POST { "image": "data:image/...;base64,..." } under 200 KB.' }, 400)
  }

  const baseUrl = env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'
  const content = [
    { type: 'text', text: LABEL_PROMPT },
    { type: 'image_url', image_url: { url: image } },
  ]
  const results = await Promise.all(
    modelChain(env, 'label').map(async (p) => {
      const startedAt = Date.now()
      const r =
        p.via === 'nvidia'
          ? await callModel(env, baseUrl, p.model, content, Date.now() + LABEL_TIMEOUT_MS, 'diag')
          : await callWorkersAi(env, p.model, content, LABEL_TIMEOUT_MS, 'diag')
      const parsed = r.content ? (parseJsonObject(r.content) ?? parseLooseReply(r.content)) : null
      return {
        model: p.model,
        ms: Date.now() - startedAt,
        outcome: parsed ? 'read' : (r.reason ?? 'unreadable reply'),
        name: parsed?.name,
        nutrition: parsed?.nutrition,
      }
    }),
  )
  return json({ results })
}

/** Under the edge's ~100s limit, since this reply is not streamed. */
const LABEL_TIMEOUT_MS = 80_000
