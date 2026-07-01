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
        // `modified` carries the full inserted row (including the client-
        // assigned `id`), but the create endpoint expects only the
        // TCreate-shaped payload — the server assigns the id.
        const { id: _id, ...rest } = mutation.modified as TRow
        await table.create(rest as unknown as Partial<TCreate>)
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
