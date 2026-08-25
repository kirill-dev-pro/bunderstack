import { getEventMeta } from '@standardserver/core'

export type RealtimeAction = 'create' | 'update' | 'delete'
export type RealtimeChange = {
  table: string
  action: RealtimeAction
  record: Record<string, unknown>
  operationId?: string
}
export type RealtimeHeartbeat = { type: 'heartbeat'; intervalMs?: number }
export type RealtimeEvent = RealtimeChange | RealtimeHeartbeat
export type RealtimeProcedure = {
  call(
    input: { tables: string[] },
    options?: { signal?: AbortSignal; lastEventId?: string },
  ): Promise<AsyncIterable<RealtimeEvent>>
}
export type RealtimeSyncHandle = { close(): void; done: Promise<void> }
export type RealtimeClock = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export const DEFAULT_KEEPALIVE_MS = 5_000
export const DEFAULT_LIVENESS_FACTOR = 2.5

const systemClock: RealtimeClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type RealtimeStreamOptions = {
  subscribe: (options: {
    signal: AbortSignal
    lastEventId?: string
  }) => Promise<AsyncIterable<RealtimeEvent>>
  onChange: (change: RealtimeChange) => void
  onReconnect: () => void | Promise<void>
  onError?: (error: unknown) => void
  onRetry?: (retry: { attempt: number; delayMs: number }) => void
  signal: AbortSignal
  retryMs?: number
  maxRetryMs?: number
  livenessFactor?: number
  defaultKeepaliveMs?: number
  clock?: RealtimeClock
  random?: () => number
}

export function isRealtimeHeartbeat(
  event: RealtimeEvent,
): event is RealtimeHeartbeat {
  return 'type' in event && event.type === 'heartbeat'
}

const LIVENESS_ABORT = 'bunderstack: realtime stream went silent'

/** Shared reconnecting transport used by LiveView, Query, and DB adapters. */
export function openRealtimeStream(
  options: RealtimeStreamOptions,
): RealtimeSyncHandle {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, options.signal])
  const clock = options.clock ?? systemClock
  const random = options.random ?? Math.random
  const retryMs = Math.max(0, options.retryMs ?? 1_000)
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? 30_000)
  const livenessFactor = options.livenessFactor ?? DEFAULT_LIVENESS_FACTOR
  let keepaliveMs = options.defaultKeepaliveMs ?? DEFAULT_KEEPALIVE_MS

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const timer = clock.setTimeout(done, ms)
      function done() {
        clock.clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })

  const done = (async () => {
    let connected = false
    let lastEventId: string | undefined
    let retryAttempt = 0
    while (!signal.aborted) {
      const attempt = new AbortController()
      const attemptSignal = AbortSignal.any([signal, attempt.signal])
      let timer: unknown
      let wentSilent = false
      const disarm = () => {
        if (timer === undefined) return
        clock.clearTimeout(timer)
        timer = undefined
      }
      const arm = () => {
        disarm()
        timer = clock.setTimeout(() => {
          wentSilent = true
          attempt.abort(new Error(LIVENESS_ABORT))
        }, keepaliveMs * livenessFactor)
      }
      try {
        const events = await options.subscribe({
          signal: attemptSignal,
          lastEventId,
        })
        arm()
        if (connected) await options.onReconnect()
        connected = true
        for await (const event of events) {
          retryAttempt = 0
          if (isRealtimeHeartbeat(event)) {
            if (typeof event.intervalMs === 'number' && event.intervalMs > 0)
              keepaliveMs = event.intervalMs
            arm()
            continue
          }
          arm()
          const id = getEventMeta(event)?.id
          if (id) lastEventId = id
          try {
            options.onChange(event)
          } catch (error) {
            options.onError?.(error)
          }
          if (signal.aborted) break
        }
      } catch (error) {
        if (!signal.aborted && !wentSilent) options.onError?.(error)
      } finally {
        disarm()
      }
      if (!signal.aborted) {
        const attemptNumber = retryAttempt + 1
        const ceiling = Math.min(maxRetryMs, retryMs * 2 ** retryAttempt)
        const delayMs = Math.floor(random() * ceiling)
        retryAttempt = attemptNumber
        options.onRetry?.({ attempt: attemptNumber, delayMs })
        await wait(delayMs)
      }
    }
  })()
  return { close: () => controller.abort(), done }
}
