import {
  openRealtimeStream,
  type RealtimeProcedure,
  type RealtimeSyncHandle,
} from 'bunderstack-client'

type SyncableCollection = {
  utils: {
    writeUpsert(item: unknown): void
    writeDelete(key: unknown): void
    refetch(): Promise<void>
  }
}

export type SyncRealtimeTarget = {
  applyRealtimeEvent(
    action: 'create' | 'update' | 'delete',
    record: Record<string, unknown>,
  ): void
  refetchAll(): Promise<void>
}

export type SyncRealtimeConfig = {
  api: { realtime: { changes: RealtimeProcedure } }
  tables: string[]
  collections?: Record<string, SyncableCollection>
  resolve?: (table: string) => SyncRealtimeTarget | undefined
  resolveAll?: () => Iterable<SyncRealtimeTarget>
  signal?: AbortSignal
  retryMs?: number
  maxRetryMs?: number
  onError?: (error: unknown) => void
}

/** TanStack DB consumes the shared raw stream without a QueryClient detour. */
export function createSyncRealtimeClient(
  config: SyncRealtimeConfig,
): RealtimeSyncHandle {
  const collections = config.collections ?? {}
  const caller = new AbortController()
  const signal = config.signal
    ? AbortSignal.any([caller.signal, config.signal])
    : caller.signal

  const stream = openRealtimeStream({
    signal,
    retryMs: config.retryMs,
    maxRetryMs: config.maxRetryMs,
    onError: config.onError,
    subscribe: ({ signal, lastEventId }) =>
      config.api.realtime.changes.call(
        { tables: config.tables },
        { signal, lastEventId },
      ),
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

  return {
    close() {
      caller.abort()
      stream.close()
    },
    done: stream.done,
  }
}
