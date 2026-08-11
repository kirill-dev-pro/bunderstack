import { getEventMeta } from '@standardserver/core'
import type { QueryClient, QueryKey } from '@tanstack/query-core'

export type RealtimeChange = {
  table: string
  action: 'create' | 'update' | 'delete'
  record: Record<string, unknown>
}

export type RealtimeProcedure = {
  call(input: { tables: string[] }, options?: { signal?: AbortSignal; lastEventId?: string }): Promise<AsyncIterable<RealtimeChange>>
}

export type RealtimeQueryApi = {
  realtime: { changes: RealtimeProcedure }
  [table: string]: any
}

export type RealtimeSyncOptions = {
  api: RealtimeQueryApi
  queryClient: QueryClient
  tables: string[]
  signal?: AbortSignal
  retryMs?: number
  onChange?: (change: RealtimeChange) => void
  onError?: (error: unknown) => void
}

export type RealtimeSyncHandle = { close(): void; done: Promise<void> }

function tableQueryKey(api: RealtimeQueryApi, table: string): QueryKey {
  return api[table]?.key?.({ type: 'query' }) ?? [[table], { type: 'query' }]
}

function detailQueryKey(api: RealtimeQueryApi, table: string, id: unknown): QueryKey {
  return api[table]?.get?.queryKey?.({ input: { id } }) ?? [[table, 'get'], { type: 'query', input: { id } }]
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function syncRealtime(options: RealtimeSyncOptions): RealtimeSyncHandle {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const retryMs = options.retryMs ?? 1_000

  const invalidateAll = async () => {
    await Promise.all(options.tables.map((table) => options.queryClient.invalidateQueries({ queryKey: tableQueryKey(options.api, table) })))
  }

  const apply = (change: RealtimeChange) => {
    options.onChange?.(change)
    const id = change.record['id']
    if (id !== undefined) {
      const queryKey = detailQueryKey(options.api, change.table, id)
      if (change.action === 'delete') options.queryClient.removeQueries({ queryKey })
      else options.queryClient.setQueryData(queryKey, change.record)
    }
    void options.queryClient.invalidateQueries({ queryKey: tableQueryKey(options.api, change.table) })
  }

  const done = (async () => {
    let connected = false
    let lastEventId: string | undefined
    while (!signal.aborted) {
      try {
        const changes = await options.api.realtime.changes.call({ tables: options.tables }, { signal, lastEventId })
        if (connected) await invalidateAll()
        connected = true
        for await (const change of changes) {
          const id = getEventMeta(change)?.id
          if (id) lastEventId = id
          apply(change)
          if (signal.aborted) break
        }
      } catch (error) {
        if (!signal.aborted) options.onError?.(error)
      }
      if (!signal.aborted) await wait(retryMs, signal)
    }
  })()

  return { close: () => controller.abort(), done }
}
