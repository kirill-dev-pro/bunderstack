import { createRealtimeClient, type RealtimeEvent } from 'bunderstack-query'
import type { QueryClient } from '@tanstack/react-query'

type SyncableCollection = {
  utils: {
    writeUpsert: (item: unknown) => void
    writeDelete: (key: unknown) => void
    refetch: () => Promise<void>
  }
}

export type SyncRealtimeConfig = {
  baseUrl: string
  queryClient: QueryClient
  fetch?: typeof fetch
  /** Map of table name -> the collection that table's rows sync into. */
  collections: Record<string, SyncableCollection>
}

export function createSyncRealtimeClient(config: SyncRealtimeConfig) {
  const tables = Object.keys(config.collections)

  return createRealtimeClient({
    baseUrl: config.baseUrl,
    queryClient: config.queryClient,
    tables,
    fetch: config.fetch,
    applyEvent: (evt: RealtimeEvent) => {
      const collection = config.collections[evt.table]
      if (!collection) return
      if (evt.action === 'delete') {
        collection.utils.writeDelete(evt.record['id'])
      } else {
        collection.utils.writeUpsert(evt.record)
      }
    },
    onGap: () => {
      for (const collection of Object.values(config.collections)) {
        void collection.utils.refetch()
      }
    },
  })
}
