export type WorkerHandle = {
  readonly closed: Promise<void>
  close(): Promise<void>
}

export type StartWorkerOptions = {
  signal?: AbortSignal
  pollIntervalMs?: number
  tick: (now: number) => Promise<void>
  onError?: (error: Error) => void
}

export type RunWorkerOptions = StartWorkerOptions

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function startJobWorker(options: StartWorkerOptions): WorkerHandle {
  const controller = new AbortController()
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  const closed = (async () => {
    try {
      while (!controller.signal.aborted) {
        try {
          await options.tick(Date.now())
        } catch (error) {
          options.onError?.(toError(error))
        }
        await wait(pollIntervalMs, controller.signal)
      }
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  })()
  const close = () => {
    controller.abort()
    return closed
  }
  return { closed, close }
}
