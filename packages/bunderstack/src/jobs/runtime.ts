export type WorkerHandle = {
  readonly closed: Promise<void>
  close(): Promise<void>
}

export type WorkerCycleResult = {
  /** Settles when the loop should look again before its deadline. */
  wake?: Promise<void>
  /** When the earliest work the cycle saw comes due. The loop sleeps until
   *  then, but never longer than `pollIntervalMs`. */
  nextAt?: number
}

/** A dedicated worker hears no enqueues from the processes that serve
 *  requests, so it looks for their work often. */
export const DEDICATED_POLL_INTERVAL_MS = 1_000
/** A worker embedded in the process that serves requests is woken by its
 *  enqueues and sleeps until its next due work; it looks this often only for
 *  rows another process wrote. */
export const EMBEDDED_POLL_INTERVAL_MS = 30_000
/** After a failed cycle the loop tries again this soon, or sooner when its
 *  interval is shorter. */
export const ERROR_RETRY_MS = 5_000

export type StartWorkerOptions = {
  signal?: AbortSignal
  /** The longest the loop waits between looks at the database. A cycle that
   *  names earlier work (`nextAt`) or settles `wake` brings the next look
   *  forward. */
  pollIntervalMs?: number
  /** One cycle. `until` is when the loop will look again at the latest, so
   *  a cycle can report work due before it without reading further ahead. */
  tick: (now: number, until: number) => Promise<void | WorkerCycleResult>
  drain?: () => Promise<void>
  onError?: (error: Error) => void
}

export type RunWorkerOptions = StartWorkerOptions

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function waitForNext(
  ms: number,
  signal: AbortSignal,
  wake: Promise<void> | undefined,
  onError: ((error: Error) => void) | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(done, ms)
    function done() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    void wake?.then(done, (error) => {
      onError?.(toError(error))
      done()
    })
    if (signal.aborted) done()
  })
}

export function startJobWorker(options: StartWorkerOptions): WorkerHandle {
  const controller = new AbortController()
  const pollIntervalMs = options.pollIntervalMs ?? DEDICATED_POLL_INTERVAL_MS
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  const closed = (async () => {
    try {
      while (!controller.signal.aborted) {
        let cycle: void | WorkerCycleResult = undefined
        let waitMs = pollIntervalMs
        const startedAt = Date.now()
        try {
          cycle = await options.tick(startedAt, startedAt + pollIntervalMs)
        } catch (error) {
          options.onError?.(toError(error))
          waitMs = Math.min(pollIntervalMs, ERROR_RETRY_MS)
        }
        if (cycle?.nextAt !== undefined) {
          waitMs = Math.min(waitMs, Math.max(0, cycle.nextAt - Date.now()))
        }
        await waitForNext(
          waitMs,
          controller.signal,
          cycle?.wake,
          options.onError,
        )
      }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      await options.drain?.()
    }
  })()
  const close = () => {
    controller.abort()
    return closed
  }
  return { closed, close }
}
