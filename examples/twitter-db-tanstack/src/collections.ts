import { QueryClient } from '@tanstack/react-query'
import { createBunderstackSyncClient } from 'bunderstack-sync'
import { createIsomorphicFn } from '@tanstack/react-start'

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
          'http://localhost:3003'
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

export function createSyncApi(queryClient: QueryClient) {
  return createBunderstackSyncClient<typeof schema>().with({
    queryClient,
    fetch: isomorphicFetch,
    tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
    buckets: ['attachments', 'avatars'] as const,
    // Realtime needs a browser-side persistent connection; skip it during SSR.
    realtime: typeof window !== 'undefined',
  })
}

export type SyncApi = ReturnType<typeof createSyncApi>
