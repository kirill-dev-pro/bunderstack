/**
 * SSR-aware fetch: the browser passes `/api/...` through as-is; on the
 * server, relative URLs are resolved against APP_URL when configured. This
 * keeps an internal HTTP reverse-proxy connection from triggering an HTTPS
 * redirect. Without APP_URL, use the incoming request's origin (via
 * @tanstack/react-start/server), then BETTER_AUTH_URL / localhost:3000.
 *
 * The server-only module uses a literal dynamic import so bundlers can analyze
 * the boundary statically; the `window` guard means it never runs in browsers.
 */
export function createIsomorphicFetch(options: { fetch?: typeof fetch } = {}) {
  const inner = options.fetch ?? fetch
  return async function isomorphicFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (typeof window !== 'undefined') return inner(input, init)
    if (typeof input === 'string' && input.startsWith('/')) {
      let origin = process.env.APP_URL
      if (origin === undefined) {
        try {
          const mod = await import('@tanstack/react-start/server')
          origin = new URL(mod.getRequest().url).origin
        } catch {
          // No request context (background job, test) — fall through to env.
        }
      }
      origin ??= process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'
      return inner(new URL(input, origin), init)
    }
    return inner(input, init)
  }
}
