import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  like,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import type { ResolvedTableAccess, SortOrder } from './access.ts'

import { ErrorCode, ListQueryError } from './errors.ts'

export const RESERVED_LIST_PARAMS = new Set([
  'limit',
  'offset',
  'sort',
  'order',
  'q',
  'cursor',
  'count',
])

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

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const v = value.toLowerCase()
  return v === 'true' || v === '1'
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 20
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new ListQueryError('limit must be an integer between 1 and 100')
  }
  return Math.min(n, 100)
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new ListQueryError('offset must be a non-negative integer')
  }
  return n
}

function parseOrder(raw: string | undefined): SortOrder {
  if (!raw || raw === 'asc') return 'asc'
  if (raw === 'desc') return 'desc'
  throw new ListQueryError('order must be "asc" or "desc"')
}

export function parseListParams(
  url: URL,
  access: ResolvedTableAccess,
): ParsedListParams {
  const params = url.searchParams
  const limit = parseLimit(params.get('limit') ?? undefined)
  const cursor = params.get('cursor')?.trim() || undefined
  const hasOffset = params.has('offset') && params.get('offset') !== ''
  const offset = hasOffset
    ? parseOffset(params.get('offset') ?? undefined)
    : undefined

  if (cursor && hasOffset) {
    throw new ListQueryError('cursor and offset cannot be used together')
  }

  const sort = params.get('sort')?.trim() || access.defaultSort.column
  const order = params.has('order')
    ? parseOrder(params.get('order') ?? undefined)
    : params.has('sort')
      ? 'asc'
      : access.defaultSort.order

  if (!access.sortableColumns.includes(sort)) {
    throw new ListQueryError(`sort column "${sort}" is not allowed`)
  }

  const filters: Record<string, unknown> = {}
  for (const [key, value] of params.entries()) {
    if (RESERVED_LIST_PARAMS.has(key)) continue
    if (!access.filterableColumns.includes(key)) {
      throw new ListQueryError(`filter column "${key}" is not allowed`)
    }
    filters[key] = value === 'null' ? null : value
  }

  const q = params.get('q')?.trim().slice(0, 100) ?? ''
  const count = parseBoolean(params.get('count') ?? undefined)

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
    limit,
    offset: cursor ? undefined : (offset ?? 0),
    sort,
    order,
    q,
    cursor,
    count,
    filters,
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
  const conditions = searchableColumns
    .filter((name) => name in columns)
    .map((name) => like(columns[name]!, pattern))
  return conditions.length ? or(...conditions) : undefined
}

function coerceFilterValue(
  table: Parameters<typeof getTableColumns>[0],
  columnName: string,
  raw: unknown,
): unknown {
  if (raw === null) return null
  const col = getTableColumns(table)[columnName]
  if (!col) return raw

  const dataType = col.dataType
  if (
    dataType === 'number' ||
    dataType === 'integer' ||
    dataType === 'bigint'
  ) {
    const n = Number(raw)
    if (Number.isNaN(n)) {
      throw new ListQueryError(`filter "${columnName}" must be a number`)
    }
    return n
  }
  if (dataType === 'boolean') {
    const s = String(raw).toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
    throw new ListQueryError(`filter "${columnName}" must be a boolean`)
  }
  return String(raw)
}

function buildFilterWhere(
  table: Parameters<typeof getTableColumns>[0],
  filters: Record<string, unknown>,
): SQL | undefined {
  const columns = getTableColumns(table)
  const conditions: SQL[] = []

  for (const [name, raw] of Object.entries(filters)) {
    const col = columns[name]
    if (!col) continue
    const value = coerceFilterValue(table, name, raw)
    if (value === null) {
      conditions.push(sql`${col} IS NULL`)
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
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    )
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
  const sortValue = coerceFilterValue(table, sortColName, cursor.v)

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
  db: LibSQLDatabase<Record<string, unknown>>,
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
