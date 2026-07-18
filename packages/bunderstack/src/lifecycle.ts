export type Cleanup = () => void | Promise<void>
export type LifecycleStatus = 'ready' | 'closing' | 'closed'

export class Lifecycle {
  #controller = new AbortController()
  #status: LifecycleStatus = 'ready'
  #cleanups = new Set<Cleanup>()
  #closePromise: Promise<void> | undefined

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get status(): LifecycleStatus {
    return this.#status
  }

  add(cleanup: Cleanup): () => void {
    if (this.#status !== 'ready') {
      throw new Error('[bunderstack] application lifecycle is closed')
    }
    this.#cleanups.add(cleanup)
    return () => this.#cleanups.delete(cleanup)
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#status = 'closing'
    this.#controller.abort()
    this.#closePromise = (async () => {
      const cleanups = [...this.#cleanups].reverse()
      this.#cleanups.clear()
      const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
      this.#status = 'closed'
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length > 0) {
        throw new AggregateError(errors, '[bunderstack] lifecycle cleanup failed')
      }
    })()
    return this.#closePromise
  }
}
