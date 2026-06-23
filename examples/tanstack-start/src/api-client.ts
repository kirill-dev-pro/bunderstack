import { QueryClient } from '@tanstack/react-query'
import { createBunderstackQueryClient } from 'bunderstack-query'

import type * as schema from './schema'

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

export function replyParams(postId: number) {
  return {
    replyToId: postId,
    sort: 'createdAt',
    order: 'asc',
    limit: 20,
  } as const
}

export const api = createBunderstackQueryClient<typeof schema>().withTables({
  queryClient,
  tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
})
