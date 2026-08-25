import { QueryClient } from '@tanstack/react-query'
import { createClient } from 'bunderstack/query'

import type { App } from './bunderstack'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
}

export function createApi(queryClient: QueryClient) {
  return createClient<App>({ queryClient })
}

export type AppApi = ReturnType<typeof createApi>
