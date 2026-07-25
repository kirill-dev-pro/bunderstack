import { QueryClient } from '@tanstack/react-query'
import {
  createSyncClient,
  type AnyBunderstackApp,
  type BunderstackSyncClient,
} from 'bunderstack-sync'

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
 * QueryClient defaults, and a sync client whose tables and buckets are
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
    createApi: (queryClient: QueryClient): BunderstackSyncClient<TApp> =>
      createSyncClient<TApp>({
        queryClient,
        fetch: isoFetch,
        baseUrl: options.baseUrl,
      }),
  }
}

type StartRequestContext = { request: Request }
type StartHandler = (ctx: StartRequestContext) => Promise<Response>

/**
 * Handlers object for the catch-all API file route.
 *
 * @example
 * // src/routes/api/$.tsx
 * export const Route = createFileRoute('/api/$')({
 *   server: { handlers: createApiHandlers(app) },
 * })
 */
export function createApiHandlers(app: {
  handler: (req: Request) => Promise<Response>
}): {
  GET: StartHandler
  POST: StartHandler
  PATCH: StartHandler
  DELETE: StartHandler
} {
  const handle: StartHandler = ({ request }) => app.handler(request)
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle }
}

export type SessionUser = {
  id: string
  email: string
  name: string
  image?: string | null
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
