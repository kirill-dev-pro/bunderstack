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

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
})

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

export const api = createBunderstackQueryClient<typeof schema>().with({
  queryClient,
  fetch: isomorphicFetch,
  tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
  buckets: ['attachments', 'avatars'] as const,
})
