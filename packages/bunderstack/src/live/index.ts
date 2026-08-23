import type { LiveFrame, LiveInput } from './protocol'

import { applyLiveFrame } from './apply'
import { parseSseFrames } from './sse'

export type {
  LiveDeltaFrame,
  LiveFrame,
  LiveHeartbeatFrame,
  LiveInput,
  LiveRemoveFrame,
  LiveSnapshotFrame,
  LiveUpsertFrame,
} from './protocol'
export { applyLiveFrame } from './apply'
export { parseSseFrames } from './sse'

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'failed'

export type LiveView<TRow extends { id: string }> = {
  /** The current rows. A new array appears only when the view changes. */
  getRows: () => readonly TRow[]
  getStatus: () => LiveStatus
  getError: () => unknown
  /** Register a listener; the return value removes it. */
  subscribe: (listener: () => void) => () => void
  /**
   * Write to the view before the server confirms. Replace a row rather than
   * mutating it, so consumers that compare by identity see the change:
   * `patch((rows) => { rows[0] = { ...rows[0], done: true } })`.
   * The server echo replaces the write, and `resync()` discards it.
   */
  patch: (recipe: (rows: TRow[]) => void) => void
  /** Reconnect. The new snapshot is the resynchronisation. */
  resync: () => void
  /** Stop the loop and abort the request. */
  close: () => void
}

export type CreateLiveViewOptions = {
  input?: LiveInput
  /** For tests, and for a fetch that carries credentials or a base URL. */
  fetch?: typeof fetch
  /** Delay in milliseconds before retry number `attempt`, counted from zero. */
  backoff?: (attempt: number) => number
}

/** Full jitter, the same shape the realtime client uses. */
const defaultBackoff = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(30_000, 1_000 * 2 ** attempt))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function buildUrl(url: string, input: LiveInput | undefined): string {
  if (!input) return url
  const params = new URLSearchParams()
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  if (input.sort) params.set('sort', input.sort)
  if (input.order) params.set('order', input.order)
  if (input.filters && Object.keys(input.filters).length > 0) {
    params.set('filters', JSON.stringify(input.filters))
  }
  return params.size > 0 ? `${url}?${params}` : url
}

/**
 * One live view: a reconnecting loop over `GET /api/live/{table}` that folds
 * frames into an immutable array of rows.
 *
 * The view holds no cache and no second copy of the data. Every connection
 * opens with a snapshot, so a reconnect is the resynchronisation, and the
 * server places each row, so this module never sorts.
 *
 * `subscribe` plus `getRows` is the pair `useSyncExternalStore` expects. A
 * Solid or Vue binding writes `getRows()` into a store from the same listener.
 */
export function createLiveView<TRow extends { id: string }>(
  url: string,
  options: CreateLiveViewOptions = {},
): LiveView<TRow> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const backoff = options.backoff ?? defaultBackoff
  const listeners = new Set<() => void>()

  let rows: readonly TRow[] = []
  let status: LiveStatus = 'connecting'
  let error: unknown
  let closed = false
  let controller: AbortController | undefined

  const notify = () => {
    for (const listener of listeners) listener()
  }

  void (async () => {
    let attempt = 0
    while (!closed) {
      controller = new AbortController()
      try {
        const response = await fetchImpl(buildUrl(url, options.input), {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        })
        if (!response.ok || !response.body) {
          throw new Error(`live request failed (${response.status})`)
        }
        for await (const frame of parseSseFrames<LiveFrame<TRow>>(
          response.body,
        )) {
          attempt = 0
          const next = applyLiveFrame(rows, frame)
          const changed =
            next !== rows || status !== 'live' || error !== undefined
          rows = next
          status = 'live'
          error = undefined
          if (changed) notify()
        }
        // A live view never ends on its own, so reaching here is a drop.
        throw new Error('live stream closed')
      } catch (cause) {
        if (closed) return
        error = cause
        // Rows on screen mean the view still works while it reconnects.
        status = rows.length > 0 ? 'reconnecting' : 'failed'
        notify()
        await sleep(backoff(attempt++))
      }
    }
  })()

  return {
    getRows: () => rows,
    getStatus: () => status,
    getError: () => error,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    patch: (recipe) => {
      const draft = [...rows]
      recipe(draft)
      rows = draft
      notify()
    },
    resync: () => {
      controller?.abort()
    },
    close: () => {
      closed = true
      controller?.abort()
    },
  }
}
