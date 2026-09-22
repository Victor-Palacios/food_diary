import { handleExtract } from './extract'
import { handleDiag } from './diag'
import { json, type Env } from './shared'

export type { Env }

/**
 * One Worker, one deployment: static assets plus the API routes that need a
 * server. Assets are matched ahead of this script for everything except
 * /api/*, so in practice this handler only ever sees API traffic -- the
 * ASSETS fallback at the bottom is there so a misconfiguration degrades to
 * serving the app rather than to a blank 500.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/extract') {
      return withSecurityHeaders(await handleExtract(request, env, ctx))
    }

    // Diagnostic: which models actually answer for this key. See diag.ts.
    if (url.pathname === '/api/diag') {
      return withSecurityHeaders(await handleDiag(env))
    }

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        // Lets the client hide the photo buttons when Phase 2 is not wired up,
        // rather than offering an action that always fails.
        extraction: Boolean(env.NVIDIA_API_KEY),
        // Named here so a wrong model is visible without reading logs.
        textModel: env.NVIDIA_TEXT_MODEL ?? '(default)',
        visionModel: env.NVIDIA_MODEL ?? '(default)',
      })
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'no-referrer')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
