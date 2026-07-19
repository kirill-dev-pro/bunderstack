import type { QueryClient } from '@tanstack/react-query'

import { createRealtimeClient, type RealtimeEvent } from 'bunderstack-query'

type SyncableCollection = {
  utils: {
    writeUpsert: (item: unknown) => void
    writeDelete: (key: unknown) => void
    refetch: () => Promise<void>
  }
}

/** A table bundle the resolver mode routes events into (see collection.ts). */
export type SyncRealtimeTarget = {
  applyRealtimeEvent: (
    action: 'create' | 'update' | 'delete',
    record: Record<string, unknown>,
  ) => void
  refetchAll: () => Promise<void>
}

export type SyncRealtimeConfig = {
  baseUrl: string
  queryClient: QueryClient
  fetch?: typeof fetch
  /** Static map of table name -> the collection that table's rows sync into. */
  collections?: Record<string, SyncableCollection>
  /** Lazy lookup: resolve a table's target at event time (proxy clients that
   * can't enumerate tables upfront). Takes precedence over `collections`. */
  resolve?: (table: string) => SyncRealtimeTarget | undefined
  /** All materialized targets — used for gap recovery in resolver mode. */
  resolveAll?: () => Iterable<SyncRealtimeTarget>
}

export function createSyncRealtimeClient(config: SyncRealtimeConfig) {
  const staticCollections = config.collections ?? {}
  const tables = Object.keys(staticCollections)

  return createRealtimeClient({
    baseUrl: config.baseUrl,
    queryClient: config.queryClient,
    tables,
    fetch: config.fetch,
    applyEvent: (evt: RealtimeEvent) => {
      if (config.resolve) {
        config.resolve(evt.table)?.applyRealtimeEvent(evt.action, evt.record)
        return
      }
      const collection = staticCollections[evt.table]
      if (!collection) return
      if (evt.action === 'delete') {
        collection.utils.writeDelete(evt.record['id'])
      } else {
        collection.utils.writeUpsert(evt.record)
      }
    },
    onGap: () => {
      if (config.resolveAll) {
        for (const target of config.resolveAll()) {
          target.refetchAll().catch((err) => {
            console.error('bunderstack-sync: gap-recovery refetch failed', err)
          })
        }
        return
      }
      for (const collection of Object.values(staticCollections)) {
        collection.utils.refetch().catch((err) => {
          console.error('bunderstack-sync: gap-recovery refetch failed', err)
        })
      }
    },
  })
}
