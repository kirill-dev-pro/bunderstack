export type WorkerHandle = {
  readonly closed: Promise<void>
  close(): Promise<void>
}

export type WorkerCycleResult = { wake?: Promise<void> }

export type StartWorkerOptions = {
  signal?: AbortSignal
  pollIntervalMs?: number
  tick: (now: number) => Promise<void | WorkerCycleResult>
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
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  const closed = (async () => {
    try {
      while (!controller.signal.aborted) {
        let cycle: void | WorkerCycleResult = undefined
        try {
          cycle = await options.tick(Date.now())
        } catch (error) {
          options.onError?.(toError(error))
        }
        await waitForNext(
          pollIntervalMs,
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
