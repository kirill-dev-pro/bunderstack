import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import { createTableClient, type TableClient } from 'bunderstack-query'

export type TableCollectionConfig = {
  tableName: string
  baseUrl: string
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
  /** Rows per sync fetch. Defaults to 100. Posts/feed-shaped tables that need
   * real pagination are handled separately in the example via a growing
   * limit — see Phase 4, Task 4.2. */
  limit?: number
}

export function createTableCollection<
  TRow extends { id: string | number },
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
>(config: TableCollectionConfig) {
  const table = createTableClient<TRow, TCreate, TUpdate>({
    tableName: config.tableName,
    baseUrl: config.baseUrl,
    fetch: config.fetch,
  })

  const collection = createCollection(
    queryCollectionOptions<TRow>({
      queryKey: [config.tableName, 'collection'],
      queryFn: async () => {
        const page = await table.list({ limit: config.limit ?? 100 })
        return page.items
      },
      queryClient: config.queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        const mutation = transaction.mutations[0]!
        // Pass the client-generated `id` through as-is. TanStack DB's
        // optimistic insert keys the local row by this `id` (via `getKey`),
        // and this matches `sanitizeWriteBody`'s default on the server: a
        // client-supplied `id` on create is accepted unless the table's
        // access config sets an explicit `writableColumns` allowlist that
        // excludes `id`. Apps that DO restrict it that way will see the
        // server regenerate the id, and the optimistic entry's key will get
        // swapped once the synced row comes back — a known, narrower
        // trade-off in that uncommon case, not the default.
        await table.create(mutation.modified as unknown as Partial<TCreate>)
      },
      onUpdate: async ({ transaction }) => {
        const mutation = transaction.mutations[0]!
        await table.update(
          mutation.key as string | number,
          mutation.changes as unknown as TUpdate,
        )
      },
      onDelete: async ({ transaction }) => {
        const mutation = transaction.mutations[0]!
        await table.delete(mutation.key as string | number)
      },
    }),
  )

  return { collection, table: table as TableClient<TRow, TCreate, TUpdate> }
}
