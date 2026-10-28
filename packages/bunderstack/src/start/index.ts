import { QueryClient } from '@tanstack/react-query'

import {
  createClient,
  type AnyBunderstackApp,
  type BunderstackClient,
} from '../query/index'
import { createIsomorphicFetch } from './isomorphic-fetch'

export { createIsomorphicFetch } from './isomorphic-fetch'

export type BunderstackStartOptions = {
  /** API mount point. Defaults to '/api'. */
  baseUrl?: string
  /** Default query staleTime (ms). Defaults to 30_000. */
  staleTime?: number
}

/**
 * One-call client setup for TanStack Start apps: SSR-aware fetch, sensible
 * QueryClient defaults, and a typed query client whose procedures and buckets are
 * inferred from the server app type.
 *
 * @example
 * // src/api.ts — NOT src/client.ts, which is a reserved TanStack Start
 * // entry-point name (it would replace the hydration entry).
 * import type { App } from './bunderstack'
 * export const { createQueryClient, createApi } = bunderstackStart<App>()
 */
export function bunderstackStart<TApp extends AnyBunderstackApp>(
  options: BunderstackStartOptions = {},
) {
  const isoFetch = createIsomorphicFetch()
  return {
    createQueryClient: () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: options.staleTime ?? 30_000 },
        },
      }),
    createApi: (queryClient: QueryClient): BunderstackClient<TApp> =>
      createClient<TApp>({
        queryClient,
        fetch: isoFetch,
        baseUrl: options.baseUrl,
      }),
  }
}

type StartRequestContext = { request: Request }
type StartHandler = (ctx: StartRequestContext) => Promise<Response>

/** Every method an oRPC/OpenAPI route can declare, plus HEAD and OPTIONS. */
type ApiMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'

/**
 * Handlers object for the catch-all API file route. It covers every method,
 * because TanStack Start sends a method with no handler to SSR: the client
 * gets 200 with HTML and the request never reaches `app.handler`.
 *
 * @example
 * // src/routes/api/$.tsx
 * export const Route = createFileRoute('/api/$')({
 *   server: { handlers: createApiHandlers(app) },
 * })
 */
export function createApiHandlers(app: {
  handler: (req: Request) => Promise<Response>
}): Record<ApiMethod, StartHandler> {
  const handle: StartHandler = ({ request }) => app.handler(request)
  return {
    GET: handle,
    HEAD: handle,
    POST: handle,
    PUT: handle,
    PATCH: handle,
    DELETE: handle,
    OPTIONS: handle,
  }
}

type TelemetryApp = {
  telemetry: {
    enabled: boolean
    captureException(
      error: unknown,
      context: {
        source: 'http'
        [key: string]: string | number | boolean | undefined
      },
    ): void
    recordRequest(sample: {
      route: string
      status: number
      durationMs: number
    }): void
  }
}

/**
 * Times SSR and other non-API requests and reports what they throw. API
 * requests are already covered by the runtime's own middleware, so wrap only
 * the server entry's `fetch`:
 *
 * @example
 * // src/server.ts
 * export default { fetch: withTelemetry(app, (req) => handler(req)) }
 */
export function withTelemetry(
  app: TelemetryApp,
  fetch: (request: Request) => Promise<Response> | Response,
): (request: Request) => Promise<Response> {
  if (!app.telemetry.enabled) return async (request) => fetch(request)
  return async (request) => {
    const startedAt = performance.now()
    let status = 200
    try {
      const response = await fetch(request)
      status = response.status
      return response
    } catch (error) {
      status = 500
      app.telemetry.captureException(error, {
        source: 'http',
        method: request.method,
        path: safePathname(request.url),
      })
      throw error
    } finally {
      app.telemetry.recordRequest({
        route: `ssr ${normalizePath(request.url)}`,
        status,
        durationMs: performance.now() - startedAt,
      })
    }
  }
}

function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

/** `/projects/42/tasks/01HX…` → `/projects/:id/tasks/:id`, as Bunderhost labels pages. */
export function normalizePath(url: string): string {
  const pathname = safePathname(url) ?? '/'
  const normalized = pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment
      if (/^\d+$/.test(segment)) return ':id'
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          segment,
        )
      )
        return ':id'
      if (/^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/.test(segment)) return ':id'
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id'
      if (segment.length > 24) return ':id'
      return segment
    })
    .join('/')
  return normalized || '/'
}

export type SessionUser = {
  id: string
  email: string
  name: string
  image?: string | null
  role?: string
}

type SessionApp = {
  auth: {
    api: {
      getSession: (opts: {
        headers: Headers
      }) => Promise<{ user: SessionUser | null } | null>
    }
  }
}

/** Resolve the BetterAuth session user for an incoming request (server-side). */
export async function getSessionUser(
  app: SessionApp,
  request: Request,
): Promise<SessionUser | null> {
  const session = await app.auth.api.getSession({ headers: request.headers })
  return session?.user ?? null
}
