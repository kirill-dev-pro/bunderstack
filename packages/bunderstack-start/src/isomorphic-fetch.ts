/**
 * SSR-aware fetch: the browser passes `/api/...` through as-is; on the
 * server, relative URLs are resolved against the incoming request's origin
 * (via @tanstack/react-start/server), falling back to APP_URL /
 * BETTER_AUTH_URL / localhost:3000 outside a request context.
 *
 * The dynamic import is marked vite-ignore so client bundles never try to
 * resolve the server-only module; the `window` guard means it never runs
 * there either.
 */
export function createIsomorphicFetch(options: { fetch?: typeof fetch } = {}) {
  const inner = options.fetch ?? fetch
  return async function isomorphicFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (typeof window !== 'undefined') return inner(input, init)
    if (typeof input === 'string' && input.startsWith('/')) {
      let origin: string | undefined
      try {
        const mod = await import(
          /* @vite-ignore */ '@tanstack/react-start/server'
        )
        origin = new URL(mod.getRequest().url).origin
      } catch {
        // No request context (background job, test) — fall through to env.
      }
      origin ??=
        process.env.APP_URL ??
        process.env.BETTER_AUTH_URL ??
        'http://localhost:3000'
      return inner(new URL(input, origin), init)
    }
    return inner(input, init)
  }
}
