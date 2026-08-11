import { QueryClient } from '@tanstack/react-query'
import { createClient, syncRealtime } from 'bunderstack-query'
import { createIsomorphicFetch } from 'bunderstack-start'

import type { App } from './bunderstack'

const fetch = createIsomorphicFetch()
const realtime = new WeakMap<QueryClient, ReturnType<typeof syncRealtime>>()

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })

export const createApi = (queryClient: QueryClient) =>
  createClient<App>({ queryClient, fetch })

export function connectRealtime(api: SyncApi, queryClient: QueryClient) {
  if (typeof window === 'undefined') return
  if (!realtime.has(queryClient)) {
    realtime.set(
      queryClient,
      syncRealtime({ api, queryClient, tables: ['projects', 'tasks'] }),
    )
  }
}

export type SyncApi = ReturnType<typeof createApi>
