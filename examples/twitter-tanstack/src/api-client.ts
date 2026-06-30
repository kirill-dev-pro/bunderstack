import type { TypeId } from 'bunderstack/typeid'

import { QueryClient } from '@tanstack/react-query'
import { createIsomorphicFn } from '@tanstack/react-start'
import { createBunderstackQueryClient } from 'bunderstack-query'

import type * as schema from './schema'

/** Bun/Node fetch requires absolute URLs during SSR; the browser accepts `/api/...`. */
const isomorphicFetch = createIsomorphicFn()
  .client((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  .server(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      let origin: string
      try {
        const { getRequest } = await import('@tanstack/react-start/server')
        origin = new URL(getRequest().url).origin
      } catch {
        origin =
          process.env.APP_URL ??
          process.env.BETTER_AUTH_URL ??
          'http://localhost:3000'
      }
      return fetch(new URL(input, origin), init)
    }
    return fetch(input, init)
  })

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
}

export function createApi(queryClient: QueryClient) {
  return createBunderstackQueryClient<typeof schema>().with({
    queryClient,
    fetch: isomorphicFetch,
    tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
    buckets: ['attachments', 'avatars'] as const,
  })
}

export type AppApi = ReturnType<typeof createApi>

export const listParams = { limit: 100, offset: 0 } as const

export const feedParams = {
  replyToId: null,
  sort: 'createdAt',
  order: 'desc',
  limit: 20,
} as const

export function replyParams(postId: TypeId<'post'>) {
  return {
    replyToId: postId,
    sort: 'createdAt',
    order: 'asc',
    limit: 20,
  } as const
}

/** Matches the server's MAX_LIST_LIMIT (packages/bunderstack/src/list-query.ts). */
export const SCOPED_FETCH_LIMIT = 200

/**
 * List params that scope a query to rows whose `column` is one of `ids`,
 * via the API's `?column=a,b,c` → `IN (...)` filter — instead of fetching an
 * entire table and hoping what you need is in the first page. Pass the
 * returned ids alongside `enabled: ids.length > 0` to skip the request when
 * there's nothing to look up yet.
 */
export function byColumnIn(column: string, ids: readonly string[]) {
  const unique = Array.from(new Set(ids)).sort()
  return { [column]: unique, limit: SCOPED_FETCH_LIMIT }
}

/** File uploads/URLs only — safe outside React hooks (no QueryClient needed). */
export const filesApi = createBunderstackQueryClient<typeof schema>().with({
  fetch: isomorphicFetch,
  tables: [] as const,
  buckets: ['attachments', 'avatars'] as const,
})
