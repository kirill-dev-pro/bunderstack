import type { QueryClient } from '@tanstack/react-query'

import {
  createCollection,
  type Collection,
  type StandardSchema,
} from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'

import { createUpdateQueue } from './update-queue'
const MAX_LIST_LIMIT = 200

type TableListResult<TRow> = {
  items: TRow[]
  hasMore: boolean
  nextCursor?: string
  total?: number
  limit?: number
  offset?: number
}

type TableProcedures<TRow, TCreate, TUpdate> = {
  list: {
    call(input?: Record<string, unknown>): Promise<TableListResult<TRow>>
  }
  get: { call(input: { id: string }): Promise<TRow> }
  create: { call(input: TCreate): Promise<TRow> }
  update: {
    call(input: {
      params: { id: string }
      query: {}
      headers: {}
      body: TUpdate
    }): Promise<TRow>
  }
  delete: { call(input: { id: string }): Promise<void> }
}

export type DirectTableApi<TRow, TCreate, TUpdate> = {
  list(input?: Record<string, unknown>): Promise<TableListResult<TRow>>
  get(id: string | number): Promise<TRow>
  create(input: TCreate): Promise<TRow>
  update(id: string | number, input: TUpdate): Promise<TRow>
  delete(id: string | number): Promise<void>
}

export type TableCollectionConfig = {
  tableName: string
  procedures: TableProcedures<any, any, any>
  queryClient: QueryClient
  /** Rows the default `.collection` syncs per fetch. Defaults to 100. For
   * feed-shaped tables that need real pagination use `scopedCollection`. */
  limit?: number
}

export type ScopedFilterValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number)[]

export type ScopedCollectionOptions = {
  /** Equality filters, e.g. `{ replyToId: null }` — columns must be in the
   * table's `filterableColumns` server-side. */
  filter?: Record<string, ScopedFilterValue>
  sort?: string
  order?: 'asc' | 'desc'
  /** Rows per underlying request; clamped to the server cap (200). */
  pageSize?: number
  /** Window size on first load and default `loadMore` step. Defaults to 20. */
  initialCount?: number
}

function matchesFilter(
  record: Record<string, unknown>,
  filter: Record<string, ScopedFilterValue>,
): boolean {
  for (const [col, expected] of Object.entries(filter)) {
    const actual = record[col]
    if (expected === null) {
      if (actual != null) return false
    } else if (Array.isArray(expected)) {
      if (!expected.map(String).includes(String(actual))) return false
    } else if (String(actual) !== String(expected)) return false
  }
  return true
}

/** Deterministic serialization for cache keys (object key order ignored). */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
  return `{${entries.join(',')}}`
}

export function createTableCollection<
  TRow extends { id: string | number },
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
>(config: TableCollectionConfig) {
  const table = config.procedures as TableProcedures<TRow, TCreate, TUpdate>
  const direct: DirectTableApi<TRow, TCreate, TUpdate> = {
    list(input = {}) {
      const { limit, offset, cursor, sort, order, q, count, ...filters } = input
      return table.list.call({
        limit,
        offset,
        cursor,
        sort,
        order,
        q,
        count,
        filters,
      })
    },
    get: (id) => table.get.call({ id: String(id) }),
    create: (input) => table.create.call(input),
    update: (id, input) =>
      table.update.call({
        params: { id: String(id) },
        query: {},
        headers: {},
        body: input,
      }),
    delete: (id) => table.delete.call({ id: String(id) }),
  }

  const collection = createCollection(
    queryCollectionOptions<TRow>({
      queryKey: [config.tableName, 'collection'],
      queryFn: async () => {
        const page = await table.list.call({ limit: config.limit ?? 100 })
        return page.items
      },
      queryClient: config.queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        let reconciled = true
        for (const mutation of transaction.mutations) {
          // Pass the client-generated `id` through as-is. TanStack DB's
          // optimistic insert keys the local row by this `id` (via `getKey`),
          // and this matches `sanitizeWriteBody`'s default on the server: a
          // client-supplied `id` on create is accepted unless the table's
          // access config sets an explicit `writableColumns` allowlist that
          // excludes `id`.
          const row = (await table.create.call(
            mutation.modified as unknown as TCreate,
          )) as TRow | undefined
          // Apps that DO restrict it that way get a server-assigned id, which
          // leaves the optimistic row keyed under the client's — `writeUpsert`
          // can't retire that, so those fall back to the refetch.
          if (row?.id != null && String(row.id) === String(mutation.key)) {
            applyRealtimeEvent('create', row as Record<string, unknown>)
          } else {
            reconciled = false
          }
        }
        return reconciled ? { refetch: false } : {}
      },
      onUpdate: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            updateQueue.enqueue(
              mutation.key as TRow['id'],
              mutation.changes as Record<string, unknown>,
            ),
          ),
        )
        return { refetch: false }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          // Updates still queued for this row are superseded, and one already
          // in flight must land before the DELETE or the two race.
          await updateQueue.settle(mutation.key as TRow['id'])
          await table.delete.call({ id: String(mutation.key) })
          applyRealtimeEvent('delete', { id: mutation.key })
        }
        return { refetch: false }
      },
    }),
  )

  // Cursor-shaped workloads call `update()` many times a second. The queue
  // merges everything that piles up for a row while its request is in flight
  // into a single follow-up, so request rate tracks RTT, not call rate.
  const updateQueue = createUpdateQueue<TRow['id'], TRow>({
    send: (id, changes) =>
      table.update.call({
        params: { id: String(id) },
        query: {},
        headers: {},
        body: changes as unknown as TUpdate,
      }),
    onResult: async (row) => {
      // `writeUpsert` writes the response whole, so mutation endpoints are
      // contracted to return a full row. A body without an id can't be
      // reconciled locally — fall back to the refetch rather than write it.
      if ((row as TRow | undefined)?.id == null)
        await collection.utils.refetch()
      else applyRealtimeEvent('update', row as Record<string, unknown>)
    },
  })

  type Collection = typeof collection

  // Scoped/byIds collections register here so realtime events fan out to
  // every live view of this table, filtered client-side by each view's
  // own predicate (broadcasts are already access-filtered server-side).
  const registry: {
    collection: Collection
    matches: (record: Record<string, unknown>) => boolean
    refetch: () => Promise<void>
  }[] = []

  const scopedCache = new Map<string, ScopedCollection>()

  type ScopedCollection = {
    collection: Collection
    /** Grow the window by `count` (default initialCount) and refetch in place. */
    loadMore: (count?: number) => Promise<void>
    /** Whether the server reported rows beyond the window (as of last fetch). */
    hasMore: () => boolean
    /** Current desired window size. */
    size: () => number
  }

  function scopedCollection(
    options: ScopedCollectionOptions = {},
  ): ScopedCollection {
    const pageSize = Math.min(
      options.pageSize ?? MAX_LIST_LIMIT,
      MAX_LIST_LIMIT,
    )
    const initialCount = options.initialCount ?? 20
    const filter = options.filter ?? {}
    const cacheKey = stableKey({
      filter,
      sort: options.sort ?? null,
      order: options.order ?? null,
      pageSize,
      initialCount,
    })
    const cached = scopedCache.get(cacheKey)
    if (cached) return cached

    let desiredCount = initialCount
    let serverHasMore = false

    const scoped = createCollection(
      queryCollectionOptions<TRow>({
        queryKey: [config.tableName, 'scoped', cacheKey],
        queryFn: async () => {
          // Growing window: walk cursor pages (each ≤ the server cap) until
          // the current desired count is collected or the table runs out.
          // The collection stays stable across loadMore — refetching in
          // place only ever adds rows, so already-rendered items never
          // unmount (no scroll jumps or zero-item flashes).
          const items: TRow[] = []
          let cursor: string | undefined
          let more = false
          while (items.length < desiredCount) {
            const remaining = Math.min(pageSize, desiredCount - items.length)
            const page = await table.list.call({
              filters: filter,
              ...(options.sort ? { sort: options.sort } : {}),
              ...(options.order ? { order: options.order } : {}),
              limit: remaining,
              ...(cursor ? { cursor } : {}),
            })
            items.push(...page.items)
            more = Boolean(page.hasMore && page.nextCursor)
            if (!more) break
            cursor = page.nextCursor
          }
          serverHasMore = more
          return items.slice(0, desiredCount)
        },
        queryClient: config.queryClient,
        getKey: (item) => item.id,
      }),
    )

    const entry: ScopedCollection = {
      collection: scoped,
      loadMore: async (count) => {
        desiredCount += count ?? initialCount
        await scoped.utils.refetch()
      },
      hasMore: () => serverHasMore,
      size: () => desiredCount,
    }
    registry.push({
      collection: scoped,
      matches: (record) => matchesFilter(record, filter),
      refetch: async () => {
        await scoped.utils.refetch()
      },
    })
    scopedCache.set(cacheKey, entry)
    return entry
  }

  const byIdsCache = new Map<string, Collection>()

  function collectionByIds(
    ids: readonly TRow['id'][],
    options: { column?: string } = {},
  ): Collection {
    const column = options.column ?? 'id'
    const unique = Array.from(new Set(ids.map(String))).sort()
    const cacheKey = `${column}:${unique.join(',')}`
    const cached = byIdsCache.get(cacheKey)
    if (cached) return cached

    const idSet = new Set(unique)
    const byIds = createCollection(
      queryCollectionOptions<TRow>({
        queryKey: [config.tableName, 'byIds', column, unique],
        queryFn: async () => {
          if (unique.length === 0) return []
          const items: TRow[] = []
          // Chunked at the server's IN-filter cap so any id set works.
          for (let i = 0; i < unique.length; i += MAX_LIST_LIMIT) {
            const chunk = unique.slice(i, i + MAX_LIST_LIMIT)
            const page = await table.list.call({
              filters: { [column]: chunk },
              limit: chunk.length,
            })
            items.push(...page.items)
          }
          return items
        },
        queryClient: config.queryClient,
        getKey: (item) => item.id,
      }),
    )
    registry.push({
      collection: byIds,
      matches: (record) => idSet.has(String(record[column])),
      refetch: async () => {
        await byIds.utils.refetch()
      },
    })
    byIdsCache.set(cacheKey, byIds)
    return byIds
  }

  function applyRealtimeEvent(
    action: 'create' | 'update' | 'delete',
    record: Record<string, unknown>,
  ) {
    const id = record['id'] as string | number
    const apply = (
      target: Collection,
      matches: (record: Record<string, unknown>) => boolean,
    ) => {
      // Collections that never started syncing (no subscribers yet) can't
      // accept manual writes — and don't need to: their first sync fetches
      // fresh data anyway.
      if (target.status !== 'ready') return
      if (action === 'delete' || !matches(record)) {
        if (target.get(id) !== undefined) target.utils.writeDelete(id)
      } else {
        target.utils.writeUpsert(record as unknown as TRow)
      }
    }
    apply(collection, () => true)
    for (const entry of registry) apply(entry.collection, entry.matches)
  }

  /** Refetch the base collection plus every scoped/byIds view after reconnect. */
  async function refetchAll() {
    await Promise.all([
      collection.utils.refetch(),
      ...registry.map((entry) => entry.refetch()),
    ])
  }

  return {
    collection,
    table: direct,
    scopedCollection,
    collectionByIds,
    applyRealtimeEvent,
    refetchAll,
  }
}

export type ScopedCollection<TRow extends { id: string | number }> = {
  collection: Collection<
    TRow,
    string | number,
    Record<string, any>,
    StandardSchema<TRow>
  >
  loadMore: (count?: number) => Promise<void>
  hasMore: () => boolean
  size: () => number
}

export type TableCollection<
  TRow extends { id: string | number },
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
> = {
  collection: Collection<
    TRow,
    string | number,
    Record<string, any>,
    StandardSchema<TRow>
  >
  table: DirectTableApi<TRow, TCreate, TUpdate>
  scopedCollection: (
    options?: ScopedCollectionOptions,
  ) => ScopedCollection<TRow>
  collectionByIds: (
    ids: readonly (string | number)[],
    column?: string,
  ) => Collection<
    TRow,
    string | number,
    Record<string, any>,
    StandardSchema<TRow>
  >
  applyRealtimeEvent: (
    action: 'create' | 'update' | 'delete',
    record: Record<string, unknown>,
  ) => void
  refetchAll: () => Promise<void>
}
