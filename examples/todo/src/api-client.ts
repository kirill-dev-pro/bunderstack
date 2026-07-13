import { QueryClient } from '@tanstack/react-query'
import { createClient } from 'bunderstack-query'

import type { App } from './bunderstack' // type-only — zero server bytes

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
}

/**
 * Fully typed API client inferred from the server.
 *
 * - `api.todos.list()`, `api.todos.create()`, etc. — auto-CRUD
 * - `api.trpc.stats.queryOptions()` — tRPC query, typed, superjson dates
 * - `api.trpc.complete.mutationOptions()` — mark done + send email
 *
 * Add a table or procedure server-side and the client knows it instantly.
 */
export function createApi(queryClient: QueryClient) {
  return createClient<App>({ queryClient })
}

export type AppApi = ReturnType<typeof createApi>
