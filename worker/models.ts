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
 * Cloudflare Workers AI is in the chain too. It runs inside Cloudflare and
 * needs no NVIDIA key, so it also covers the failure nothing else does:
 * NVIDIA itself being down, or the key being revoked.
 *
 * The order was set by probing each model with a real image through
 * /api/diag, not by reading NVIDIA's catalog: being listed there does not
 * mean a model answers. Re-run /api/diag when something changes.
 */

export interface Provider {
  via: 'nvidia' | 'workers-ai'
  model: string
}

const nv = (model: string): Provider => ({ via: 'nvidia', model })
const cf = (model: string): Provider => ({ via: 'workers-ai', model })

/**
 * Reads a label or a plate photo, fastest first. Chosen by POSTing a real
 * nutrition label to /api/diag on 2026-10-31, which every model below read
 * perfectly (7 of 7 figures) except the two at the end:
 *
 *   nemotron-3.5-super-vl     2.2s
 *   Llama 4 Scout (Workers)   4.0s
 *   Mistral Small 3.1 (Wkrs)  4.7s
 *   llama-3.2-90b-vision     35.7s  (and timed out on an earlier probe)
 *   gemma-3-12b, 11b-vision   404   kept in case they return; ~30ms each
 *
 * Mixing providers is deliberate: the two Workers AI models are faster than
 * NVIDIA's own 90B, and they need no key.
 */
export const PHOTO_CHAIN: Provider[] = [
  nv('nvidia/nemotron-3.5-super-vl-120b-a12b'),
  cf('@cf/meta/llama-4-scout-17b-16e-instruct'),
  cf('@cf/mistralai/mistral-small-3.1-24b-instruct'),
  nv('meta/llama-3.2-90b-vision-instruct'),
  nv('google/gemma-3-12b-it'),
  // The original choice. Answers 404 since late October 2026.
  nv('meta/llama-3.2-11b-vision-instruct'),
]

/**
 * Text-only models, tried before the photo chain for a description.
 * glm-5.3-flash answered in 6.6-11s; gemma-4-31b, the previous choice,
 * timed out on every probe, so it goes after the photo chain rather than
 * costing a minute up front.
 */
export const TEXT_FIRST: Provider[] = [nv('z-ai/glm-5.3-flash')]
export const TEXT_LAST: Provider[] = [nv('google/gemma-4-31b-it')]

/** The NVIDIA and Workers AI subsets, in chain order. */
export const NVIDIA_VISION_MODELS = PHOTO_CHAIN.filter((p) => p.via === 'nvidia').map((p) => p.model)
export const NVIDIA_TEXT_MODELS = [...TEXT_FIRST, ...TEXT_LAST].map((p) => p.model)
export const WORKERS_AI_MODELS = PHOTO_CHAIN.filter((p) => p.via === 'workers-ai').map((p) => p.model)

/** "a, b , c" -> ["a", "b", "c"], so a chain can be overridden in config. */
function list(value: string | undefined): string[] | null {
  const items = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : null
}

/**
 * The chain for one request. A description tries the text-only model first,
 * then the photo chain (vision models read text perfectly well), then the
 * slow text model. A photo skips the text models, which cannot see.
 *
 * NVIDIA_VISION_MODELS / NVIDIA_TEXT_MODELS in wrangler.jsonc replace the
 * NVIDIA defaults, with Workers AI then going after them. The older
 * single-model NVIDIA_MODEL / NVIDIA_TEXT_MODEL, if still set, go first
 * rather than being ignored. A provider whose credential is missing is left
 * out entirely.
 */
export function modelChain(env: Env, kind: 'label' | 'plate' | 'text'): Provider[] {
  const visionOverride = list(env.NVIDIA_VISION_MODELS)
  const textOverride = list(env.NVIDIA_TEXT_MODELS)
  const workersAi = PHOTO_CHAIN.filter((p) => p.via === 'workers-ai')

  const photo = visionOverride ? [...visionOverride.map(nv), ...workersAi] : PHOTO_CHAIN
  const legacyVision = env.NVIDIA_MODEL ? [nv(env.NVIDIA_MODEL)] : []
  const legacyText = env.NVIDIA_TEXT_MODEL ? [nv(env.NVIDIA_TEXT_MODEL)] : []

  const ordered =
    kind === 'text'
      ? textOverride
        ? [...legacyText, ...textOverride.map(nv), ...legacyVision, ...photo]
        : [...legacyText, ...TEXT_FIRST, ...legacyVision, ...photo, ...TEXT_LAST]
      : [...legacyVision, ...photo]

  const chain: Provider[] = []
  const seen = new Set<string>()
  for (const p of ordered) {
    if (seen.has(p.model)) continue
    if (p.via === 'nvidia' && !env.NVIDIA_API_KEY) continue
    if (p.via === 'workers-ai' && !env.AI) continue
    seen.add(p.model)
    chain.push(p)
  }
  return chain
}

/** True when at least one provider is usable, which is what the UI keys off. */
export function extractionConfigured(env: Env): boolean {
  return Boolean(env.NVIDIA_API_KEY || env.AI)
}
