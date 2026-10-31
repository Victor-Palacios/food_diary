export interface Env {
  ASSETS: Fetcher
  /** Secret binding. Set with `wrangler secret put NVIDIA_API_KEY`. */
  NVIDIA_API_KEY?: string
  NVIDIA_BASE_URL?: string
  /** Comma-separated vision chain, replacing the defaults in models.ts. */
  NVIDIA_VISION_MODELS?: string
  /** Comma-separated text chain, replacing the defaults in models.ts. */
  NVIDIA_TEXT_MODELS?: string
  /** Older single-model settings. Still honoured, tried first, if set. */
  NVIDIA_MODEL?: string
  NVIDIA_TEXT_MODEL?: string
  /** Workers AI: the keyless last resort at the end of every chain. */
  AI?: Ai
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
