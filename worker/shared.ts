export interface Env {
  ASSETS: Fetcher
  /** Secret binding. Set with `wrangler secret put NVIDIA_API_KEY`. */
  NVIDIA_API_KEY?: string
  NVIDIA_BASE_URL?: string
  /** Vision model, for reading a label or a plate photo. */
  NVIDIA_MODEL?: string
  /** Text-only model, for parsing or estimating a written description. */
  NVIDIA_TEXT_MODEL?: string
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
