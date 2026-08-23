import { createRoot, createSignal, onCleanup, untrack } from 'solid-js'
import { createStore } from 'solid-js'

import {
  todosCreate,
  todosDelete,
  todosLive,
  todosUpdate,
} from '../api.gen'

export type Todo = {
  id: string
  title: string
  done: boolean
  createdAt: string
}

/** The live-view wire contract (src/api/live-view.ts in bunderstack). */
type Frame =
  | {
      type: 'snapshot'
      items: Record<string, unknown>[]
      sort?: string
      order?: 'asc' | 'desc'
      limit?: number
    }
  | { type: 'upsert'; record: Record<string, unknown> }
  | { type: 'remove'; id: string }
  | { type: 'heartbeat'; intervalMs: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

/** Where a row belongs in an already-sorted view; ties go newest-first. */
function insertionIndex(
  rows: Todo[],
  record: Todo,
  sort: string,
  order: 'asc' | 'desc',
): number {
  const index = rows.findIndex((row) => {
    const comparison = compare(record[sort as keyof Todo], row[sort as keyof Todo])
    return order === 'desc' ? comparison >= 0 : comparison < 0
  })
  return index === -1 ? rows.length : index
}

export type ViewMeta = { sort: string; order: 'asc' | 'desc'; limit: number }

/**
 * One frame folded into the view's rows. Pure, so the tricky parts —
 * upsert-replaces semantics above all — are testable without a reactive
 * runtime.
 */
export function applyFrame(
  rows: readonly Todo[],
  frame: Frame,
  meta: ViewMeta,
): Todo[] {
  if (frame.type === 'snapshot') {
    return frame.items.map((record) => record as Todo)
  }
  if (frame.type === 'upsert') {
    const record = frame.record as Todo
    // Upsert means replace: drop the stale copy first, or an update would
    // duplicate its own row (equal sort keys place the fresh record right
    // next to the stale one).
    const withoutStale = rows.filter((row) => row.id !== record.id)
    withoutStale.splice(
      insertionIndex(withoutStale, record, meta.sort, meta.order),
      0,
      record,
    )
    return withoutStale.slice(0, meta.limit)
  }
  if (frame.type === 'remove') {
    return rows.filter((row) => row.id !== frame.id)
  }
  return [...rows] // heartbeat — unreachable via sseFrames
}

export type TodoStore = {
  readonly items: readonly Todo[]
  readonly connected: boolean
  /** True once the first snapshot has landed. */
  readonly ready: boolean
  /** Set when a connection failed before any data arrived. */
  readonly error: unknown
  /** Optimistic draft write for actions. */
  patch: (recipe: (draft: Todo[]) => void) => void
  /** Drop the current connection; the loop reconnects with a fresh snapshot. */
  resync: () => void
}

/**
 * One store driven by one infinite loop over `GET /api/todos/live`: a
 * snapshot frame first, then server-decided upsert/remove frames forever.
 * Reconnecting restarts the stream, and the stream's own snapshot is the
 * recovery — there is no separate refetch path, no event buffering, no local
 * filter evaluation anywhere.
 *
 * The loop is deliberately imperative. Solid's derived stores pull an async
 * iterable exactly once — they are reads, not subscriptions — so a stream
 * that pushes forever cannot live inside a computation; it lives here and
 * writes into a plain store.
 */
export function createTodoStore(): TodoStore {
  // A detached reactive root: the loop and its signals need an owner so they
  // dispose with the component that created them (and tests can run bare).
  return createRoot((dispose) => {
    const [items, setItems] = createStore<Todo[]>([])
    const [connected, setConnected] = createSignal(false)
    const [ready, setReady] = createSignal(false)
    const [error, setError] = createSignal<unknown>(undefined)

    let disposed = false
    let current: AbortController | undefined
    // The authoritative local copy of the view. Reads through the store can
    // lag one flush behind a just-applied write, so frames fold into this
    // array, not into the store's view of itself.
    let rows: Todo[] = []

    void (async () => {
      let attempt = 0
      let sort: 'createdAt' | 'done' = 'createdAt'
      let order: 'asc' | 'desc' = 'desc'
      let limit = 100
      while (!disposed) {
        const controller = new AbortController()
        current = controller
        try {
          for await (const raw of todosLive(
            { sort, order, limit },
            controller.signal,
          )) {
            const frame = raw as Frame
            attempt = 0
            untrack(() => {
              setConnected(true)
              setReady(true)
              setError(undefined)
            })

            if (frame.type === 'snapshot') {
              sort = (frame.sort ?? sort) as typeof sort
              order = frame.order ?? order
              limit = frame.limit ?? limit
            }
            rows = applyFrame(rows, frame, { sort, order, limit })
            setItems(() => [...rows])
          }
          throw new Error('realtime stream closed')
        } catch (cause) {
          if (disposed) return
          untrack(() => {
            setConnected(false)
            // Only surface failures that leave us with nothing to show;
            // otherwise the next backoff reconnects and the snapshot heals.
            setError((previous) => previous ?? cause)
          })
          const delay = Math.floor(
            Math.random() * Math.min(30_000, 1_000 * 2 ** attempt++),
          )
          await sleep(delay)
        }
      }
    })()

    onCleanup(() => {
      disposed = true
      current?.abort()
    })

    return {
      get items() {
        return items
      },
      get connected() {
        return connected()
      },
      get ready() {
        return ready()
      },
      get error() {
        return error()
      },
      // Optimistic writes land in the loop's local copy as well, or the next
      // unrelated frame would resurrect the pre-patch row.
      patch: (recipe: (draft: Todo[]) => void) => {
        recipe(rows)
        setItems(recipe)
      },
      resync: () => {
        setError(undefined)
        // Aborting makes the in-flight read throw, which sends the loop through
        // its backoff and into a fresh connection — whose snapshot is the sync.
        current?.abort()
      },
    }
  })
}

export { todosCreate, todosDelete, todosUpdate }
