import { createSignal, onSettled, refresh, untrack } from 'solid-js'
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

export type TodoStore = {
  /** Async read — unsettled until the first snapshot reaches `<Loading>`. */
  readonly items: readonly Todo[]
  readonly connected: boolean
  /** Optimistic draft write for actions; failures resync instead of reverting. */
  patch: (recipe: (draft: Todo[]) => void) => void
  /** Re-runs the projection — the authoritative answer after any failure. */
  resync: () => void
}

/**
 * The whole data layer.
 *
 * `items` is one projection store driven by one infinite async iterator over
 * `GET /api/todos/live`: a snapshot frame first, then server-decided
 * upsert/remove frames forever. Reconnecting restarts the stream, and the
 * stream's own snapshot is the recovery — there is no separate refetch path,
 * no event buffering, no local filter evaluation anywhere.
 */
export function createTodoStore(): TodoStore {
  const [connected, setConnected] = createSignal(false)
  let disposed = false

  const [items, setItems] = createStore<Todo[]>(
    async function* () {
      let rows: Todo[] = []
      let sort = ''
      let order: 'asc' | 'desc' = 'desc'
      let limit: number | undefined

      while (!disposed) {
        const controller = new AbortController()
        try {
          for await (const frame of todosLive(
            { sort: 'createdAt', order: 'desc', limit: 100 },
            controller.signal,
          )) {
            untrack(() => setConnected(true))

            if (frame.type === 'snapshot') {
              sort = frame.sort ?? ''
              order = frame.order ?? 'desc'
              limit = frame.limit
              rows = frame.items.map((record) => record as Todo)
            } else if (frame.type === 'upsert') {
              const record = frame.record as Todo
              // The default sort is createdAt desc; without metadata, new
              // rows go on top.
              const at =
                sort !== '' ? insertionIndex(rows, record, sort, order) : 0
              rows.splice(at, 0, record)
              if (limit !== undefined && rows.length > limit && sort !== '') {
                rows.length = limit
              }
            } else if (frame.type === 'remove') {
              rows = rows.filter((row) => row.id !== frame.id)
            } else {
              continue // heartbeat
            }

            // A fresh array per frame, so the projection reconciles by id and
            // surviving rows keep their proxy identity.
            yield [...rows]
          }
        } catch {
          // Dropped — fall through to the backoff below.
        }
        controller.abort()
        if (disposed) return
        untrack(() => setConnected(false))
        await sleep(Math.floor(Math.random() * 3_000))
      }
    },
    [],
    { key: 'id' },
  )

  onSettled(() => {
    return () => {
      disposed = true
    }
  })

  return {
    get items() {
      return items
    },
    get connected() {
      return connected()
    },
    patch: setItems,
    resync: () => refresh(items),
  }
}

export { todosCreate, todosDelete, todosUpdate }
