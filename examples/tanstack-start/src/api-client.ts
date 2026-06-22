import { QueryClient } from '@tanstack/react-query'
import { createBunderstackQueryClient } from 'bunderstack-query'

import type * as schema from './schema'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
})

export const listParams = { limit: 5, offset: 0 } as const

export const api = createBunderstackQueryClient<typeof schema>().withTables({
  queryClient,
  tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
})
