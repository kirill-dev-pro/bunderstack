import type { CallOptions } from './rpc-client'

export type LiveViewFrame<T> =
  | { type: 'snapshot'; items: T[]; operationId?: string }
  | {
      type: 'upsert'
      record: T
      afterId?: string | null
      operationId?: string
    }
  | { type: 'remove'; id: string; operationId?: string }
  | { type: 'heartbeat'; intervalMs?: number }

export type LiveViewStatus =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'error'
  | 'closed'

export type LiveViewSnapshot<T> = {
  readonly items: readonly T[]
  readonly status: LiveViewStatus
  readonly error: unknown
}

export type LiveViewOptions<T> = {
  subscribe: (options: {
    signal: AbortSignal
  }) =>
    | AsyncIterable<LiveViewFrame<T>>
    | Promise<AsyncIterable<LiveViewFrame<T>>>
  getKey?: (record: T) => string
  createOperationId?: () => string
  retryMs?: number
  /** Reconnect after this multiple of the server heartbeat interval is silent. */
  livenessFactor?: number
  /** Maximum wait after HTTP success for the matching live frame. */
  ackTimeoutMs?: number
}

export type MutationMethod<TArgs, TResult> = (
  args: TArgs,
  options: CallOptions & { operationId: string },
) => Promise<TResult>

export type LiveView<T> = {
  getSnapshot(): LiveViewSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate<TArgs, TResult>(
    method: MutationMethod<TArgs, TResult>,
    args: TArgs,
    options?: Omit<CallOptions, 'operationId'>,
  ): Promise<TResult>
  resync(): void
  close(): void
  readonly done: Promise<void>
}

type Waiter = {
  httpSucceeded: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

export function createLiveView<T>(options: LiveViewOptions<T>): LiveView<T> {
  const controller = new AbortController()
  const listeners = new Set<() => void>()
  const waiters = new Map<string, Waiter>()
  const getKey =
    options.getKey ?? ((record: T) => String((record as { id: unknown }).id))
  let current: AbortController | undefined
  let forceReconnect = false
  let hasSnapshot = false
  let snapshot: LiveViewSnapshot<T> = {
    items: [],
    status: 'connecting',
    error: undefined,
  }

  const publish = (next: LiveViewSnapshot<T>) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const apply = (frame: LiveViewFrame<T>) => {
    if (frame.type !== 'heartbeat') {
      let items: readonly T[]
      if (frame.type === 'snapshot') {
        hasSnapshot = true
        items = [...frame.items]
      } else if (frame.type === 'remove') {
        items = snapshot.items.filter(
          (record) => getKey(record) !== String(frame.id),
        )
      } else {
        const key = getKey(frame.record)
        const index = snapshot.items.findIndex(
          (record) => getKey(record) === key,
        )
        const next = snapshot.items.filter((record) => getKey(record) !== key)
        if (frame.afterId === undefined) {
          if (index === -1) next.push(frame.record)
          else next.splice(index, 0, frame.record)
        } else {
          const anchor =
            frame.afterId === null
              ? -1
              : next.findIndex(
                  (record) => getKey(record) === String(frame.afterId),
                )
          const placement =
            frame.afterId !== null && anchor === -1 ? next.length : anchor + 1
          next.splice(placement, 0, frame.record)
        }
        items = next
      }
      publish({ items, status: 'ready', error: undefined })
      if (frame.type === 'snapshot') {
        // A fresh snapshot is authoritative. Once the write request succeeded,
        // it safely settles operations whose matching event was lost while the
        // live connection was down.
        for (const [operationId, waiter] of waiters) {
          if (!waiter.httpSucceeded) continue
          waiter.resolve()
          waiters.delete(operationId)
        }
      }
    }
    if ('operationId' in frame && frame.operationId) {
      waiters.get(frame.operationId)?.resolve()
      waiters.delete(frame.operationId)
    }
  }

  const done = (async () => {
    let attempt = 0
    while (!controller.signal.aborted) {
      current = new AbortController()
      const signal = AbortSignal.any([controller.signal, current.signal])
      let heartbeatIntervalMs: number | undefined
      let livenessTimer: ReturnType<typeof setTimeout> | undefined
      const armLivenessTimer = () => {
        if (livenessTimer) clearTimeout(livenessTimer)
        if (!heartbeatIntervalMs) return
        livenessTimer = setTimeout(
          () => current?.abort(),
          heartbeatIntervalMs * (options.livenessFactor ?? 2.5),
        )
      }
      try {
        const frames = await options.subscribe({ signal })
        for await (const frame of frames) {
          if (signal.aborted) break
          attempt = 0
          apply(frame)
          if (frame.type === 'heartbeat' && frame.intervalMs) {
            heartbeatIntervalMs = frame.intervalMs
          }
          armLivenessTimer()
        }
        if (!signal.aborted) throw new Error('Live view closed')
      } catch (error) {
        if (controller.signal.aborted) break
        publish({
          ...snapshot,
          status: hasSnapshot ? 'reconnecting' : 'error',
          error: hasSnapshot ? undefined : error,
        })
      } finally {
        if (livenessTimer) clearTimeout(livenessTimer)
      }
      if (!controller.signal.aborted) {
        const delayMs = forceReconnect
          ? 0
          : Math.min(30_000, (options.retryMs ?? 1_000) * 2 ** attempt++)
        forceReconnect = false
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, delayMs)
            function done() {
              clearTimeout(timer)
              controller.signal.removeEventListener('abort', done)
              resolve()
            }
            controller.signal.addEventListener('abort', done, { once: true })
          })
        }
      }
    }
    if (controller.signal.aborted) {
      publish({ ...snapshot, status: 'closed' })
    }
  })()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(method, args, callOptions = {}) {
      const operationId = options.createOperationId?.() ?? crypto.randomUUID()
      let waiter!: Waiter
      const acknowledged = new Promise<void>((resolve, reject) => {
        waiter = { httpSucceeded: false, resolve, reject }
      })
      // The HTTP request may fail before this promise is awaited. Attaching a
      // handler now prevents that rejection from surfacing as unhandled.
      void acknowledged.catch(() => {})
      waiters.set(operationId, waiter)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await method(args, { ...callOptions, operationId })
        waiter.httpSucceeded = true
        const timedOut = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `Operation ${operationId} acknowledgement timed out`,
            )
            waiters.delete(operationId)
            reject(error)
          }, options.ackTimeoutMs ?? 30_000)
        })
        await Promise.race([acknowledged, timedOut])
        return result
      } catch (error) {
        waiters.delete(operationId)
        waiter.reject(error)
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    resync() {
      forceReconnect = true
      current?.abort()
    },
    close() {
      controller.abort()
      const error = new DOMException('Live view closed', 'AbortError')
      for (const waiter of waiters.values()) waiter.reject(error)
      waiters.clear()
    },
    done,
  }
}
