import type { QueryClient, QueryKey } from '@tanstack/query-core'

import { getEventMeta } from '@standardserver/core'

export type RealtimeChange = {
  table: string
  action: 'create' | 'update' | 'delete'
  record: Record<string, unknown>
}

export type RealtimeHeartbeat = { type: 'heartbeat' }

export type RealtimeEvent = RealtimeChange | RealtimeHeartbeat

export type RealtimeProcedure = {
  call(
    input: { tables: string[] },
    options?: { signal?: AbortSignal; lastEventId?: string },
  ): Promise<AsyncIterable<RealtimeEvent>>
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
  /** Initial reconnect delay before jitter. Defaults to 1 second. */
  retryMs?: number
  /** Maximum reconnect delay before jitter. Defaults to 30 seconds. */
  maxRetryMs?: number
  onChange?: (change: RealtimeChange) => void
  onReconnect?: () => void | Promise<void>
  onError?: (error: unknown) => void
  onRetry?: (retry: { attempt: number; delayMs: number }) => void
}

export type RealtimeSyncHandle = { close(): void; done: Promise<void> }

function isRealtimeHeartbeat(event: RealtimeEvent): event is RealtimeHeartbeat {
  return 'type' in event && event.type === 'heartbeat'
}

function tableQueryKey(api: RealtimeQueryApi, table: string): QueryKey {
  return api[table]?.key?.({ type: 'query' }) ?? [[table], { type: 'query' }]
}

function detailQueryKey(
  api: RealtimeQueryApi,
  table: string,
  id: unknown,
): QueryKey {
  return (
    api[table]?.get?.queryKey?.({ input: { id } }) ?? [
      [table, 'get'],
      { type: 'query', input: { id } },
    ]
  )
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
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const retryMs = Math.max(0, options.retryMs ?? 1_000)
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? 30_000)

  const invalidateAll = async () => {
    await Promise.all(
      options.tables.map((table) =>
        options.queryClient.invalidateQueries({
          queryKey: tableQueryKey(options.api, table),
        }),
      ),
    )
  }

  const apply = (change: RealtimeChange) => {
    options.onChange?.(change)
    const id = change.record['id']
    if (id !== undefined) {
      const queryKey = detailQueryKey(options.api, change.table, id)
      if (change.action === 'delete')
        options.queryClient.removeQueries({ queryKey })
      else options.queryClient.setQueryData(queryKey, change.record)
    }
    void options.queryClient.invalidateQueries({
      queryKey: tableQueryKey(options.api, change.table),
    })
  }

  const done = (async () => {
    let connected = false
    let lastEventId: string | undefined
    let retryAttempt = 0
    while (!signal.aborted) {
      try {
        const changes = await options.api.realtime.changes.call(
          { tables: options.tables },
          { signal, lastEventId },
        )
        if (connected) {
          await invalidateAll()
          await options.onReconnect?.()
        }
        connected = true
        for await (const event of changes) {
          retryAttempt = 0
          if (isRealtimeHeartbeat(event)) continue
          const id = getEventMeta(event)?.id
          if (id) lastEventId = id
          apply(event)
          if (signal.aborted) break
        }
      } catch (error) {
        if (!signal.aborted) options.onError?.(error)
      }
      if (!signal.aborted) {
        const attempt = retryAttempt + 1
        const ceiling = Math.min(maxRetryMs, retryMs * 2 ** retryAttempt)
        const delayMs = Math.floor(Math.random() * ceiling)
        retryAttempt = attempt
        options.onRetry?.({ attempt, delayMs })
        await wait(delayMs, signal)
      }
    }
  })()

  return { close: () => controller.abort(), done }
}
