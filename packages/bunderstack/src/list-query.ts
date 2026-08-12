import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  is,
  like,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

import type { ResolvedTableAccess, SortOrder } from './access'
import type { AnyDb } from './dialect'

import { ErrorCode, ListQueryError } from './errors'

/** Caps both `?limit=` and the number of values in an `IN` filter. */
export const MAX_LIST_LIMIT = 200

/** Default page size when a request omits `limit`. */
export const DEFAULT_LIST_LIMIT = 20

/**
 * What a list procedure accepts. Shape and column types are enforced by the
 * generated input schema, so by the time these params arrive they are already
 * validated and coerced — this module only applies policy (defaults, the limit
 * cap, cursor rules).
 */
export type ListParamsInput = {
  limit?: number
  offset?: number
  cursor?: string
  sort?: string
  order?: SortOrder
  q?: string
  count?: boolean
  filters?: Record<string, unknown>
}

export type ParsedListParams = {
  limit: number
  offset?: number
  sort: string
  order: SortOrder
  q: string
  cursor?: string
  count: boolean
  filters: Record<string, unknown>
}

export type ListResult<T> = {
  items: T[]
  limit: number
  offset?: number
  cursor?: string
  nextCursor?: string
  hasMore: boolean
  total?: number
  q?: string
  sort: string
  order: SortOrder
}

type CursorPayload = {
  sort: string
  order: SortOrder
  v: string | number | null
  id: string | number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!isRecord(value)) return false
  return (
    typeof value.sort === 'string' &&
    (value.order === 'asc' || value.order === 'desc') &&
    (value.v === null ||
      typeof value.v === 'string' ||
      typeof value.v === 'number') &&
    (typeof value.id === 'string' || typeof value.id === 'number')
  )
}

/**
 * Applies list policy to already-validated input: defaults, the limit cap, and
 * the rules a schema cannot express (cursor excludes offset, and a cursor must
 * agree with the sort it was minted for).
 */
export function resolveListParams(
  input: ListParamsInput,
  access: ResolvedTableAccess,
): ParsedListParams {
  const cursor = input.cursor?.trim() || undefined
  if (cursor && input.offset !== undefined) {
    throw new ListQueryError('cursor and offset cannot be used together')
  }

  const sort = input.sort ?? access.defaultSort.column
  const order = input.order ?? (input.sort ? 'asc' : access.defaultSort.order)

  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded.sort !== sort || decoded.order !== order) {
      throw new ListQueryError(
        'cursor does not match sort and order parameters',
        ErrorCode.INVALID_CURSOR,
      )
    }
  }

  return {
    limit: Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    offset: cursor ? undefined : (input.offset ?? 0),
    sort,
    order,
    q: input.q?.trim() ?? '',
    cursor,
    count: input.count ?? false,
    filters: input.filters ?? {},
  }
}

function buildSearchWhere(
  table: Parameters<typeof getTableColumns>[0],
  searchableColumns: string[] | undefined,
  q: string,
): SQL | undefined {
  if (!q || !searchableColumns?.length) return undefined
  const columns = getTableColumns(table)
  const pattern = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
  // LIKE is case-insensitive in SQLite but case-sensitive in Postgres; use
  // ilike there so search behaves identically across dialects.
  const likeOp = is(table, PgTable) ? ilike : like
  const conditions = searchableColumns
    .filter((name) => name in columns)
    .map((name) => likeOp(columns[name]!, pattern))
  return conditions.length ? or(...conditions) : undefined
}

/**
 * Cursors carry their sort value as JSON, so a date column arrives as a string
 * and has to be rebuilt. Filter values need no such repair — the generated
 * input schema already types them.
 */
function coerceCursorValue(
  table: Parameters<typeof getTableColumns>[0],
  columnName: string,
  raw: string | number | null,
): unknown {
  if (raw === null) return null
  const col = getTableColumns(table)[columnName]
  if (col?.dataType === 'date') return new Date(raw)
  return raw
}

function buildFilterWhere(
  table: Parameters<typeof getTableColumns>[0],
  filters: Record<string, unknown>,
): SQL | undefined {
  const columns = getTableColumns(table)
  const conditions: SQL[] = []

  for (const [name, value] of Object.entries(filters)) {
    const col = columns[name]
    if (!col || value === undefined) continue

    if (value === null) {
      conditions.push(sql`${col} IS NULL`)
    } else if (Array.isArray(value)) {
      if (value.length) conditions.push(inArray(col, value))
    } else {
      conditions.push(eq(col, value))
    }
  }

  return conditions.length ? and(...conditions) : undefined
}

function serializeCursorValue(value: unknown): string | number | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' || typeof value === 'string') return value
  return String(value)
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isCursorPayload(parsed)) {
      throw new Error('invalid cursor shape')
    }
    return parsed
  } catch {
    throw new ListQueryError('invalid cursor', ErrorCode.INVALID_CURSOR)
  }
}

function buildCursorWhere(
  table: Parameters<typeof getTableColumns>[0],
  sortColName: string,
  order: SortOrder,
  cursor: CursorPayload,
  idCol: unknown,
): SQL {
  const columns = getTableColumns(table)
  const sortCol = columns[sortColName]!
  const sortValue = coerceCursorValue(table, sortColName, cursor.v)

  if (order === 'desc') {
    return or(
      lt(sortCol, sortValue),
      and(eq(sortCol, sortValue), lt(idCol as never, cursor.id)),
    )!
  }
  return or(
    gt(sortCol, sortValue),
    and(eq(sortCol, sortValue), gt(idCol as never, cursor.id)),
  )!
}

function buildOrderBy(
  table: Parameters<typeof getTableColumns>[0],
  sortColName: string,
  order: SortOrder,
  idCol: unknown,
) {
  const columns = getTableColumns(table)
  const sortCol = columns[sortColName]!
  const idOrder = order === 'asc' ? asc(idCol as never) : desc(idCol as never)
  return order === 'asc' ? [asc(sortCol), idOrder] : [desc(sortCol), idOrder]
}

export async function executeList<T extends Record<string, unknown>>(
  db: AnyDb,
  table: Parameters<typeof getTableColumns>[0],
  access: ResolvedTableAccess,
  params: ParsedListParams,
  idCol: unknown,
  scopeWhere?: SQL,
): Promise<ListResult<T>> {
  const searchWhere = buildSearchWhere(
    table,
    access.searchableColumns,
    params.q,
  )
  const filterWhere = buildFilterWhere(table, params.filters)
  let where = and(
    ...(searchWhere ? [searchWhere] : []),
    ...(filterWhere ? [filterWhere] : []),
    ...(scopeWhere ? [scopeWhere] : []),
  )

  if (params.cursor) {
    const cursorPayload = decodeCursor(params.cursor)
    const cursorWhere = buildCursorWhere(
      table,
      params.sort,
      params.order,
      cursorPayload,
      idCol,
    )
    where = where ? and(where, cursorWhere) : cursorWhere
  }

  const orderBy = buildOrderBy(table, params.sort, params.order, idCol)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (db as any).select().from(table)
  if (where) query = query.where(where)
  query = query.orderBy(...orderBy)

  if (params.offset !== undefined) {
    query = query.limit(params.limit).offset(params.offset)
  } else {
    query = query.limit(params.limit)
  }

  const items = (await query) as T[]

  let total: number | undefined
  if (params.count) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let countQuery = (db as any)
      .select({ count: sql<number>`count(*)` })
      .from(table)
    if (where) countQuery = countQuery.where(where)
    const [row] = await countQuery
    total = Number(row?.count ?? 0)
  }

  const hasMore =
    total !== undefined && params.offset !== undefined
      ? params.offset + items.length < total
      : items.length === params.limit

  let nextCursor: string | undefined
  if (items.length === params.limit) {
    const last = items[items.length - 1]!
    nextCursor = encodeCursor({
      sort: params.sort,
      order: params.order,
      v: serializeCursorValue(last[params.sort]),
      id: last.id as string | number,
    })
  }

  return {
    items,
    limit: params.limit,
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    hasMore,
    ...(total !== undefined ? { total } : {}),
    ...(params.q ? { q: params.q } : {}),
    sort: params.sort,
    order: params.order,
  }
}
