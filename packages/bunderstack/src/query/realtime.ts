import type { QueryClient, QueryKey } from '@tanstack/query-core'

import { hashKey, notifyManager } from '@tanstack/query-core'

import type {
  AnyBunderstackApp,
  InferSchema,
  InferSelect,
  InferTables,
} from './infer'
import type { NotifyScheduler, RealtimeClock } from './realtime-flush'
import type {
  RealtimeAction,
  RealtimeChange,
  RealtimeProcedure,
  RealtimeSyncHandle,
} from './realtime-stream'

import { createFlushScheduler } from './realtime-flush'
import { openRealtimeStream } from './realtime-stream'

// The event types live with the stream that produces them; re-exported here so
// the package's public surface is unchanged.
export type { NotifyScheduler, RealtimeClock } from './realtime-flush'
export type {
  RealtimeAction,
  RealtimeChange,
  RealtimeEvent,
  RealtimeHeartbeat,
  RealtimeProcedure,
  RealtimeSyncHandle,
} from './realtime-stream'

/**
 * The change for one table, with `record` typed as that table's row.
 *
 * Passing the app type to `syncRealtime` turns `tables` into a checked list of
 * exposed table names and `onChange` into a union discriminated by `table`, so
 * `change.table === 'todos'` narrows `change.record` to the todo row:
 *
 * ```ts
 * syncRealtime<App>({
 *   api,
 *   queryClient,
 *   tables: ['todos'],
 *   onChange: (change) => {
 *     if (change.table === 'todos') console.log(change.record.done)
 *   },
 * })
 * ```
 */
export type RealtimeChangeFor<
  TApp extends AnyBunderstackApp,
  TTable extends InferTables<TApp>,
> = {
  table: TTable
  action: RealtimeAction
  record: InferSelect<InferSchema<TApp>[TTable]>
  operationId?: string
}

/**
 * Untyped when no app type is supplied, so existing callers — and consumers
 * that only have a structural client — keep the loose `RealtimeChange`.
 */
export type RealtimeChangeOf<TApp, TTable extends string> = [TApp] extends [
  never,
]
  ? RealtimeChange
  : TApp extends AnyBunderstackApp
    ? TTable extends InferTables<TApp>
      ? RealtimeChangeFor<TApp, TTable>
      : RealtimeChange
    : RealtimeChange

/** Every exposed table name, or any string when no app type is supplied. */
export type RealtimeTableName<TApp> = [TApp] extends [never]
  ? string
  : TApp extends AnyBunderstackApp
    ? InferTables<TApp>
    : string

export type RealtimeQueryApi = {
  realtime: { changes: RealtimeProcedure }
  [table: string]: any
}

/**
 * How a change reaches the cache.
 *
 * `invalidate` (default) marks the table's queries stale and lets TanStack
 * Query refetch them — always correct, one request per change.
 *
 * `patch` writes the change into cached list results instead, so a write costs
 * no extra request. The event carries the action and the full row, and
 * Bunderstack's list contract is narrow enough to decide membership locally:
 * filters are `=`, `IN`, or `IS NULL`, and ordering is a single column. Any
 * list where that is not decidable — a text search, or a page that is not the
 * complete result — falls back to invalidation.
 */
export type RealtimeApplyStrategy = 'invalidate' | 'patch'

export type RealtimeSyncOptions<
  TApp = never,
  TTable extends string = RealtimeTableName<TApp>,
> = {
  api: RealtimeQueryApi
  queryClient: QueryClient
  tables: TTable[]
  signal?: AbortSignal
  /** Defaults to `'invalidate'`. */
  apply?: RealtimeApplyStrategy
  /**
   * When buffered changes reach the cache. Defaults to `'frame'`, which
   * collapses a burst into one cache write and one invalidation per table.
   * Pass `'sync'` to write as each change arrives, as versions before 0.18 did.
   */
  notifyScheduler?: NotifyScheduler
  /** Timer functions, injectable for tests. */
  clock?: RealtimeClock
  /** Initial reconnect delay before jitter. Defaults to 1 second. */
  retryMs?: number
  /** Maximum reconnect delay before jitter. Defaults to 30 seconds. */
  maxRetryMs?: number
  onChange?: (change: RealtimeChangeOf<TApp, TTable>) => void
  onReconnect?: () => void | Promise<void>
  onError?: (error: unknown) => void
  onRetry?: (retry: { attempt: number; delayMs: number }) => void
}

function tableQueryKey(api: RealtimeQueryApi, table: string): QueryKey {
  return api[table]?.key?.({ type: 'query' }) ?? [[table], { type: 'query' }]
}

function detailQueryKey(
  api: RealtimeQueryApi,
  table: string,
  id: unknown,
): QueryKey {
  return (
    api[table]?.get?.queryKey?.({ input: { id } }) ?? [
      [table, 'get'],
      { type: 'query', input: { id } },
    ]
  )
}

function listQueryKey(api: RealtimeQueryApi, table: string): QueryKey {
  return (
    api[table]?.list?.key?.({ type: 'query' }) ?? [
      [table, 'list'],
      { type: 'query' },
    ]
  )
}

/** The shape every generated list endpoint returns, as far as patching cares. */
type ListSnapshot = {
  items: Record<string, unknown>[]
  hasMore?: boolean
  total?: number
  offset?: number
  cursor?: string
  q?: string
  sort?: string
  order?: 'asc' | 'desc'
}

function isListSnapshot(value: unknown): value is ListSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as ListSnapshot).items)
  )
}

/** Dates arrive as Dates over the wire, so identity is not enough. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/**
 * Bunderstack's filter contract is narrow by design — a scalar is `=`, an
 * array is `IN`, and `null` is `IS NULL` — so membership is decidable against
 * a single record without asking the server.
 */
function matchesFilters(
  record: Record<string, unknown>,
  filters: Record<string, unknown> | undefined,
): boolean {
  for (const [column, expected] of Object.entries(filters ?? {})) {
    if (expected === undefined) continue
    const actual = record[column]
    if (expected === null) {
      if (actual !== null && actual !== undefined) return false
      continue
    }
    if (Array.isArray(expected)) {
      if (!expected.some((value) => sameValue(value, actual))) return false
      continue
    }
    if (!sameValue(expected, actual)) return false
  }
  return true
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}

/**
 * Where the row goes in an already-sorted page.
 *
 * Ties are common rather than exotic: a `timestamp` column stores seconds, so
 * rows written in the same second share a sort value. SQL does not define an
 * order within a tie, so the new row is placed as the most recent of its
 * equals — first under `desc`, last under `asc` — which is where a reader
 * expects a just-written row to appear.
 */
function insertionIndex(
  items: Record<string, unknown>[],
  record: Record<string, unknown>,
  sort: string,
  order: 'asc' | 'desc',
): number {
  const value = record[sort]
  const index = items.findIndex((item) => {
    const comparison = compareValues(value, item[sort])
    return order === 'desc' ? comparison >= 0 : comparison < 0
  })
  return index === -1 ? items.length : index
}

/**
 * A cached page can only absorb an insert when it already holds every row the
 * query would return. A partial page cannot: the new row may belong to another
 * page, and inserting would shift the boundary the server drew.
 */
function holdsCompleteResult(snapshot: ListSnapshot): boolean {
  return (
    snapshot.hasMore === false &&
    !snapshot.cursor &&
    (snapshot.offset === undefined || snapshot.offset === 0)
  )
}

function readInput(queryKey: QueryKey): Record<string, unknown> {
  const meta = queryKey[1] as { input?: unknown } | undefined
  const input = meta?.input
  return typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)
    : {}
}

export function syncRealtime<
  TApp = never,
  TTable extends string = RealtimeTableName<TApp>,
>(options: RealtimeSyncOptions<TApp, TTable>): RealtimeSyncHandle {
  const scheduler = createFlushScheduler(
    options.notifyScheduler ?? 'frame',
    options.clock,
  )
  /** Changes waiting for the next flush, in arrival order. */
  const buffered: RealtimeChange[] = []
  /**
   * Query keys the flush must invalidate, deduplicated by their hash. Keyed
   * this way rather than by table so a list that cannot absorb a change still
   * invalidates only itself, while a burst against one key collapses to one
   * call.
   */
  const stale = new Map<string, QueryKey>()

  const invalidateAll = async () => {
    await Promise.all(
      options.tables.map((table) =>
        options.queryClient.invalidateQueries({
          queryKey: tableQueryKey(options.api, table),
        }),
      ),
    )
  }

  /**
   * Write the change into every cached list for the table, marking the table
   * stale for any list whose membership or ordering cannot be settled locally.
   * A list is only patched when the answer is certain.
   */
  const patchLists = (change: RealtimeChange) => {
    const prefix = listQueryKey(options.api, change.table)
    const queries = options.queryClient
      .getQueryCache()
      .findAll({ queryKey: prefix })
    const id = change.record['id']

    for (const query of queries) {
      const snapshot = query.state.data
      if (!isListSnapshot(snapshot)) continue

      const queryKey = query.queryKey
      const items = snapshot.items
      const present = items.some((item) => sameValue(item['id'], id))

      if (change.action === 'delete') {
        if (!present) continue
        options.queryClient.setQueryData(queryKey, {
          ...snapshot,
          items: items.filter((item) => !sameValue(item['id'], id)),
          ...(typeof snapshot.total === 'number'
            ? { total: Math.max(0, snapshot.total - 1) }
            : {}),
        })
        continue
      }

      const input = readInput(queryKey)
      const belongs = matchesFilters(
        change.record,
        input['filters'] as Record<string, unknown> | undefined,
      )

      // An update can move a row out of a filtered list.
      if (!belongs) {
        if (!present) continue
        options.queryClient.setQueryData(queryKey, {
          ...snapshot,
          items: items.filter((item) => !sameValue(item['id'], id)),
          ...(typeof snapshot.total === 'number'
            ? { total: Math.max(0, snapshot.total - 1) }
            : {}),
        })
        continue
      }

      // Already here: replace in place and keep the row where it is.
      if (present) {
        options.queryClient.setQueryData(queryKey, {
          ...snapshot,
          items: items.map((item) =>
            sameValue(item['id'], id) ? change.record : item,
          ),
        })
        continue
      }

      // The row joins this list. Only safe on a page that holds everything,
      // and only when `q` is absent — a text match needs the server's
      // searchable columns to evaluate.
      const searched = snapshot.q ?? (input['q'] as string | undefined)
      const sort = snapshot.sort ?? (input['sort'] as string | undefined)
      const order =
        snapshot.order ?? (input['order'] as 'asc' | 'desc' | undefined)

      if (searched || !sort || !order || !holdsCompleteResult(snapshot)) {
        stale.set(hashKey(queryKey), queryKey)
        continue
      }

      const next = items.slice()
      next.splice(
        insertionIndex(items, change.record, sort, order),
        0,
        change.record,
      )
      options.queryClient.setQueryData(queryKey, {
        ...snapshot,
        items: next,
        ...(typeof snapshot.total === 'number'
          ? { total: snapshot.total + 1 }
          : {}),
      })
    }
  }

  const applyOne = (change: RealtimeChange) => {
    // The runtime shape is the same either way; the generic only narrows what
    // callers see.
    options.onChange?.(change as RealtimeChangeOf<TApp, TTable>)
    const id = change.record['id']
    if (id !== undefined) {
      const queryKey = detailQueryKey(options.api, change.table, id)
      if (change.action === 'delete')
        options.queryClient.removeQueries({ queryKey })
      else options.queryClient.setQueryData(queryKey, change.record)
    }

    if (options.apply === 'patch') {
      patchLists(change)
      return
    }

    const tableKey = tableQueryKey(options.api, change.table)
    stale.set(hashKey(tableKey), tableKey)
  }

  /**
   * One pass over the buffer, then one invalidation per stale table. The
   * second part is the point: a burst of changes to a table used to issue one
   * `invalidateQueries` each, and now issues one in total.
   */
  const flush = () => {
    if (buffered.length === 0) return
    const batch = buffered.splice(0, buffered.length)
    notifyManager.batch(() => {
      for (const change of batch) applyOne(change)
      for (const queryKey of stale.values())
        void options.queryClient.invalidateQueries({ queryKey })
      stale.clear()
    })
  }

  const stream = openRealtimeStream({
    subscribe: ({ signal, lastEventId }) =>
      options.api.realtime.changes.call(
        { tables: options.tables },
        { signal, lastEventId },
      ),
    onChange: (change) => {
      buffered.push(change)
      scheduler.schedule(flush)
    },
    onReconnect: async () => {
      // A refetch of everything supersedes whatever was still buffered.
      scheduler.cancel()
      buffered.length = 0
      stale.clear()
      await invalidateAll()
      await options.onReconnect?.()
    },
    onError: options.onError,
    onRetry: options.onRetry,
    signal: options.signal ?? new AbortController().signal,
    retryMs: options.retryMs,
    maxRetryMs: options.maxRetryMs,
    clock: options.clock,
  })

  return {
    close: () => {
      stream.close()
      // Anything already delivered is still owed to the cache.
      scheduler.cancel()
      flush()
    },
    done: stream.done,
  }
}
