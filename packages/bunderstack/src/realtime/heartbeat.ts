export const REALTIME_HEARTBEAT_INTERVAL_MS = 5_000

export type RealtimeHeartbeat = { type: 'heartbeat' }

type SourceState<T> =
  | { status: 'pending' }
  | { status: 'ready'; result: IteratorResult<T> }
  | { status: 'error'; error: unknown }

/**
 * Emits a transport-only event whenever the source has been idle for an
 * interval. Heartbeats are deliberately not published, persisted, or assigned
 * event IDs, so they do not affect replay and resume semantics.
 */
export async function* withRealtimeHeartbeat<T>(
  source: AsyncIterable<T>,
  options: { intervalMs?: number; signal?: AbortSignal },
): AsyncGenerator<T | RealtimeHeartbeat, void, void> {
  const intervalMs = Math.max(
    1,
    options.intervalMs ?? REALTIME_HEARTBEAT_INTERVAL_MS,
  )
  const iterator = source[Symbol.asyncIterator]()
  let state: SourceState<T> = { status: 'pending' }
  let wake: (() => void) | undefined
  const getState = (): SourceState<T> => state

  const requestNext = () => {
    state = { status: 'pending' }
    void iterator.next().then(
      (result) => {
        state = { status: 'ready', result }
        wake?.()
      },
      (error: unknown) => {
        state = { status: 'error', error }
        wake?.()
      },
    )
  }

  requestNext()
  try {
    while (!options.signal?.aborted) {
      let current = getState()
      if (current.status === 'pending') {
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, intervalMs)
          options.signal?.addEventListener('abort', finish, { once: true })
          wake = finish
        })
        wake = undefined

        if (options.signal?.aborted) break
        current = getState()
        if (current.status === 'pending') {
          yield { type: 'heartbeat' }
          continue
        }
      }

      if (current.status === 'error') throw current.error
      if (current.result.done) break

      yield current.result.value
      requestNext()
    }
  } finally {
    wake = undefined
    await iterator.return?.()
  }
}
