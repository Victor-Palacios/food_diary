import type { Env } from './shared'

/**
 * Which models to try, in order, for each kind of request.
 *
 * NVIDIA withdraws hosted models without notice: the 11B vision model this
 * app was built on started answering 404 one day, and photos stopped working
 * until someone noticed. A single configured model is a single point of
 * failure, so every request now walks a chain instead -- the first model
 * that answers with something readable wins, and a withdrawn, stalled or
 * failing one costs only the time it takes to fail.
 *
 * The chain ends on Cloudflare Workers AI, which runs inside Cloudflare and
 * needs no NVIDIA key at all. It is the backup for the one failure nothing
 * else covers: NVIDIA itself being down, or the key being revoked.
 *
 * The order was set by probing each model with a real image through
 * /api/diag, not by reading NVIDIA's catalog: being listed there does not
 * mean a model answers. Re-run /api/diag when something changes.
 */

export interface Provider {
  via: 'nvidia' | 'workers-ai'
  model: string
}

/** Reads a label or a plate photo. Probed 2026-10-31. */
export const NVIDIA_VISION_MODELS = [
  // Answered a real image correctly in 1.4s.
  'meta/llama-3.2-90b-vision-instruct',
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'google/gemma-3-12b-it',
  // The original choice. Answers 404 now; kept last in case it returns, at
  // a cost of ~25ms when it does not.
  'meta/llama-3.2-11b-vision-instruct',
]

/** Parses or estimates a written description. Probed 2026-10-31. */
export const NVIDIA_TEXT_MODELS = [
  // Answered in 11s.
  'z-ai/glm-5.3-flash',
  // The previous choice. Timed out at 20s in the probe.
  'google/gemma-4-31b-it',
]

/**
 * Keyless, inside Cloudflare. Both take the same image_url message parts as
 * NVIDIA's API and handle text too. Llama 3.2 Vision is deliberately absent:
 * on Workers AI it refuses every request until a licence prompt is sent.
 */
export const WORKERS_AI_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
]

/** "a, b , c" -> ["a", "b", "c"], so a chain can be overridden in config. */
function list(value: string | undefined): string[] | null {
  const items = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : null
}

/**
 * The chain for one request. Text tries the text models first, then the
 * vision models (which read text perfectly well), then Workers AI. Photos
 * skip the text models, which cannot see.
 *
 * NVIDIA_VISION_MODELS / NVIDIA_TEXT_MODELS in wrangler.jsonc replace the
 * defaults. The older single-model NVIDIA_MODEL / NVIDIA_TEXT_MODEL, if
 * still set, go first rather than being ignored. A provider whose
 * credential is missing is left out.
 */
export function modelChain(env: Env, kind: 'label' | 'plate' | 'text'): Provider[] {
  const vision = list(env.NVIDIA_VISION_MODELS) ?? NVIDIA_VISION_MODELS
  const text = list(env.NVIDIA_TEXT_MODELS) ?? NVIDIA_TEXT_MODELS

  const nvidia =
    kind === 'text'
      ? [env.NVIDIA_TEXT_MODEL, ...text, env.NVIDIA_MODEL, ...vision]
      : [env.NVIDIA_MODEL, ...vision]

  const chain: Provider[] = []
  const seen = new Set<string>()
  const add = (via: Provider['via'], model: string | undefined) => {
    if (!model || seen.has(model)) return
    seen.add(model)
    chain.push({ via, model })
  }

  if (env.NVIDIA_API_KEY) for (const m of nvidia) add('nvidia', m)
  if (env.AI) for (const m of WORKERS_AI_MODELS) add('workers-ai', m)
  return chain
}

/** True when at least one provider is usable, which is what the UI keys off. */
export function extractionConfigured(env: Env): boolean {
  return Boolean(env.NVIDIA_API_KEY || env.AI)
}
