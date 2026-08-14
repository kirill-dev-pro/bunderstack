import type { QueryClient } from '@tanstack/react-query'

import {
  syncRealtime,
  type RealtimeQueryApi,
  type RealtimeSyncHandle,
} from 'bunderstack-query'

type SyncableCollection = {
  utils: {
    writeUpsert: (item: unknown) => void
    writeDelete: (key: unknown) => void
    refetch: () => Promise<void>
  }
}

export type SyncRealtimeTarget = {
  applyRealtimeEvent: (
    action: 'create' | 'update' | 'delete',
    record: Record<string, unknown>,
  ) => void
  refetchAll: () => Promise<void>
}

export type SyncRealtimeConfig = {
  api: RealtimeQueryApi
  queryClient: QueryClient
  tables: string[]
  collections?: Record<string, SyncableCollection>
  resolve?: (table: string) => SyncRealtimeTarget | undefined
  resolveAll?: () => Iterable<SyncRealtimeTarget>
  retryMs?: number
}

export function createSyncRealtimeClient(
  config: SyncRealtimeConfig,
): RealtimeSyncHandle {
  const collections = config.collections ?? {}
  return syncRealtime({
    api: config.api,
    queryClient: config.queryClient,
    tables: config.tables,
    retryMs: config.retryMs,
    onChange: (event) => {
      if (config.resolve) {
        config
          .resolve(event.table)
          ?.applyRealtimeEvent(event.action, event.record)
        return
      }
      const collection = collections[event.table]
      if (!collection) return
      if (event.action === 'delete')
        collection.utils.writeDelete(event.record['id'])
      else collection.utils.writeUpsert(event.record)
    },
    onReconnect: async () => {
      if (config.resolveAll) {
        await Promise.all(
          [...config.resolveAll()].map((target) => target.refetchAll()),
        )
        return
      }
      await Promise.all(
        Object.values(collections).map((collection) =>
          collection.utils.refetch(),
        ),
      )
    },
  })
}
