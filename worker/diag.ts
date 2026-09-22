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
const TEXT_CANDIDATES = [
  'google/gemma-4-31b-it',
  'nvidia/nemotron-3-super-120b-a12b',
  'z-ai/glm-5.3-flash',
  'deepseek-ai/deepseek-v4.1-flash',
]

/**
 * Vision candidates get a real (tiny) image, because answering a text prompt
 * says nothing about whether a model will accept an image_url part.
 */
const VISION_CANDIDATES = [
  'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
  'google/gemma-4-31b-it',
  'microsoft/phi-3-vision-128k-instruct',
  'nvidia/nemotron-parse-2.0',
]

const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC'

const PER_MODEL_TIMEOUT_MS = 20_000

export async function handleDiag(env: Env): Promise<Response> {
  if (!env.NVIDIA_API_KEY) return json({ error: 'No NVIDIA_API_KEY configured.' }, 501)

  const baseUrl = env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'

  return json({
    configured: {
      text: env.NVIDIA_TEXT_MODEL ?? '(default)',
      vision: env.NVIDIA_MODEL ?? '(default)',
      baseUrl,
    },
    text: await probe(env, baseUrl, TEXT_CANDIDATES, false),
    vision: await probe(env, baseUrl, VISION_CANDIDATES, true),
  })
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
