import { registeredWorker } from '../workers/registry'

type IsolateContext = { request: () => Promise<Request> }

/**
 * SSR-aware fetch: the browser passes `/api/...` through as-is. On the server,
 * when this isolate runs the bunderstack Worker (a package Worker entry
 * registered it), a relative URL goes to that Worker without a network hop and
 * carries the incoming request's cookie. Otherwise relative URLs are resolved against APP_URL when configured. This
 * keeps an internal HTTP reverse-proxy connection from triggering an HTTPS
 * redirect. Without APP_URL, use the incoming request's origin (via
 * @tanstack/react-start/server), then BETTER_AUTH_URL / localhost:3000.
 *
 * The server-only module uses a literal dynamic import so bundlers can analyze
 * the boundary statically; the `window` guard means it never runs in browsers.
 */
export function createIsomorphicFetch(
  options: {
    fetch?: typeof fetch
    /** Tests only: the incoming request for the in-isolate path. */
    isolate?: IsolateContext
  } = {},
) {
  const inner = options.fetch ?? fetch
  const isolate: IsolateContext = options.isolate ?? {
    request: async () =>
      (await import('@tanstack/react-start/server')).getRequest(),
  }
  return async function isomorphicFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (typeof window !== 'undefined') return inner(input, init)
    const registered = registeredWorker()
    if (registered && typeof input === 'string' && input.startsWith('/')) {
      const incoming = await isolate.request()
      const headers = new Headers(init?.headers)
      const cookie = incoming.headers.get('cookie')
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
      const url = new URL(input, new URL(incoming.url).origin)
      return registered.worker.fetch(
        new Request(url, { ...init, headers }),
        registered.env,
        { waitUntil() {} },
      )
    }
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
