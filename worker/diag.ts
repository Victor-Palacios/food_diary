import { json, type Env } from './shared'

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
const CANDIDATES = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-nano-3-30b-a3b',
  'google/gemma-4-31b-it',
  'google/gemma-3-12b-it',
  'mistralai/mistral-large-2-instruct',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'meta/llama-3.2-90b-vision-instruct',
]

const PER_MODEL_TIMEOUT_MS = 20_000

export async function handleDiag(env: Env): Promise<Response> {
  if (!env.NVIDIA_API_KEY) return json({ error: 'No NVIDIA_API_KEY configured.' }, 501)

  const baseUrl = env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'
  const results: Array<Record<string, unknown>> = []

  for (const model of CANDIDATES) {
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
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
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

  return json({
    configured: {
      text: env.NVIDIA_TEXT_MODEL ?? '(default)',
      vision: env.NVIDIA_MODEL ?? '(default)',
      baseUrl,
    },
    results,
  })
}
