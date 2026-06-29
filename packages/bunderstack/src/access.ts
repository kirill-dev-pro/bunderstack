import { getTableColumns, getTableName, isTable } from 'drizzle-orm'

import { INTERNAL_TABLE_NAMES } from './internal-tables.ts'

export const AUTH_TABLE_NAMES = new Set([
  'user',
  'session',
  'account',
  'verification',
])

const EXPOSEABLE_AUTH_TABLES = new Set(['user'])

export type AccessUser = {
  id: string
  email: string
  name?: string
  role?: string
}

export type AccessContext = {
  user: AccessUser | null
  request: Request
  row?: Record<string, unknown>
  body?: Record<string, unknown>
  session?: { activeOrganizationId: string | null } | null
}

export type OperationRule =
  | 'public'
  | 'authenticated'
  | 'owner'
  | 'deny'
  | ((ctx: AccessContext) => boolean | Promise<boolean>)

export type ScopeMap = Record<string, string | string[]>
export type ScopeResolver = (ctx: AccessContext) => ScopeMap

export type CrudOperation = 'list' | 'get' | 'create' | 'update' | 'delete'

const RESERVED_LIST_PARAMS = new Set([
  'limit',
  'offset',
  'sort',
  'order',
  'q',
  'cursor',
  'count',
])

export type SortOrder = 'asc' | 'desc'

export type DefaultSort = {
  column: string
  order: SortOrder
}

export type TableAccessInput = {
  crud?: boolean
  /** Opt the BetterAuth `user` table into auto-CRUD (read profiles, owner-update image). */
  exposeAuthTable?: boolean
  ownerColumn?: string
  list?: OperationRule
  get?: OperationRule
  create?: OperationRule
  update?: OperationRule
  delete?: OperationRule
  writableColumns?: string[]
  readonlyColumns?: string[]
  /** Columns matched by `?q=` on list — opt-in; omitted columns are never searched. */
  searchableColumns?: string[]
  /** Columns filterable via flat `?column=value` query params. */
  filterableColumns?: string[]
  /** Columns allowed in `?sort=`. Defaults to `['id']`. */
  sortableColumns?: string[]
  /** Default list ordering when `?sort` is omitted. Defaults to `{ column: 'id', order: 'desc' }`. */
  defaultSort?: DefaultSort
  scope?: ScopeResolver
}

export type ResolvedTableAccess = {
  tableKey: string
  tableName: string
  enabled: boolean
  ownerColumn?: string
  list: OperationRule
  get: OperationRule
  create: OperationRule
  update: OperationRule
  delete: OperationRule
  writableColumns?: string[]
  readonlyColumns: string[]
  searchableColumns?: string[]
  filterableColumns: string[]
  sortableColumns: string[]
  defaultSort: DefaultSort
  scope?: ScopeResolver
}

export type ResolvedAccess = Map<string, ResolvedTableAccess>

const DEFAULT_READONLY = [
  'id',
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
]

function getSchemaTables<TSchema extends Record<string, unknown>>(
  schema: TSchema,
) {
  const tables: {
    key: string
    table: Parameters<typeof getTableName>[0]
    name: string
    columns: string[]
  }[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (!isTable(value)) continue
    const name = getTableName(value)
    const columns = Object.keys(getTableColumns(value))
    tables.push({ key, table: value, name, columns })
  }
  return tables
}

function resolveListAccess(
  input: TableAccessInput,
  columns: string[],
): Pick<
  ResolvedTableAccess,
  'filterableColumns' | 'sortableColumns' | 'defaultSort'
> {
  const sortableColumns =
    input.sortableColumns ?? (columns.includes('id') ? ['id'] : [])
  const defaultSort: DefaultSort = input.defaultSort ?? {
    column: sortableColumns[0] ?? 'id',
    order: 'desc',
  }

  if (!columns.includes(defaultSort.column)) {
    throw new Error(
      `[bunderstack] defaultSort.column "${defaultSort.column}" is not a column on this table`,
    )
  }
  if (!sortableColumns.includes(defaultSort.column)) {
    throw new Error(
      `[bunderstack] defaultSort.column "${defaultSort.column}" must be listed in sortableColumns`,
    )
  }

  const filterableColumns = input.filterableColumns ?? []
  for (const col of filterableColumns) {
    if (RESERVED_LIST_PARAMS.has(col)) {
      throw new Error(
        `[bunderstack] filterableColumns cannot include reserved query param "${col}"`,
      )
    }
    if (!columns.includes(col)) {
      throw new Error(
        `[bunderstack] filterableColumns references unknown column "${col}"`,
      )
    }
  }

  for (const col of sortableColumns) {
    if (RESERVED_LIST_PARAMS.has(col)) {
      throw new Error(
        `[bunderstack] sortableColumns cannot include reserved query param "${col}"`,
      )
    }
    if (!columns.includes(col)) {
      throw new Error(
        `[bunderstack] sortableColumns references unknown column "${col}"`,
      )
    }
  }

  return { filterableColumns, sortableColumns, defaultSort }
}

function resolveDefaults(
  input: TableAccessInput,
  ownerColumn: string | undefined,
  columns: string[],
): Omit<ResolvedTableAccess, 'tableKey' | 'tableName' | 'enabled'> {
  const listAccess = resolveListAccess(input, columns)
  return {
    ownerColumn,
    list: input.list ?? 'public',
    get: input.get ?? 'public',
    create: input.create ?? 'public',
    update: input.update ?? (ownerColumn ? 'owner' : 'deny'),
    delete: input.delete ?? (ownerColumn ? 'owner' : 'deny'),
    writableColumns: input.writableColumns,
    readonlyColumns: [
      ...DEFAULT_READONLY,
      ...(input.readonlyColumns ?? []),
      ...(ownerColumn ? [ownerColumn] : []),
    ],
    searchableColumns: input.searchableColumns,
    scope: input.scope,
    ...listAccess,
  }
}

function detectOwnerColumn(
  columns: string[],
  input?: TableAccessInput,
): string | undefined {
  if (input?.ownerColumn) return input.ownerColumn
  if (columns.includes('userId')) return 'userId'
  return undefined
}

export function validateAndResolveAccess<
  TSchema extends Record<string, unknown>,
>(
  schema: TSchema,
  accessInput?: Record<string, TableAccessInput>,
): ResolvedAccess {
  const tables = getSchemaTables(schema)
  const tableByKey = new Map(tables.map((t) => [t.key, t]))
  const resolved: ResolvedAccess = new Map()

  if (accessInput) {
    for (const key of Object.keys(accessInput)) {
      if (!tableByKey.has(key)) {
        throw new Error(
          `[bunderstack] access.${key} does not match any table in schema`,
        )
      }
      const tableName = tableByKey.get(key)!.name
      const input = accessInput[key]
      if (AUTH_TABLE_NAMES.has(tableName)) {
        if (input?.crud === false) continue
        if (!EXPOSEABLE_AUTH_TABLES.has(tableName) || !input?.exposeAuthTable) {
          throw new Error(
            `[bunderstack] access.${key} cannot target auth table "${tableName}" — use { crud: false } to silence, or exposeAuthTable on user`,
          )
        }
      }
    }
  }

  for (const { key, name, columns } of tables) {
    const input = accessInput?.[key]
    if (input?.crud === false) continue
    if (INTERNAL_TABLE_NAMES.has(name)) continue

    if (AUTH_TABLE_NAMES.has(name)) {
      if (!input?.exposeAuthTable || !EXPOSEABLE_AUTH_TABLES.has(name)) continue

      const ownerColumn = input.ownerColumn ?? 'id'
      if (!columns.includes(ownerColumn)) {
        throw new Error(
          `[bunderstack] access.${key}.ownerColumn "${ownerColumn}" is not a column on table "${name}"`,
        )
      }

      const defaults = resolveDefaults(
        {
          ...input,
          create: input.create ?? 'deny',
          delete: input.delete ?? 'deny',
        },
        ownerColumn,
        columns,
      )

      const existingReadonly = defaults.readonlyColumns.filter((col) =>
        columns.includes(col),
      )
      const resolvedReadonly = [...new Set(existingReadonly)]

      for (const col of [
        ...(defaults.writableColumns ?? []),
        ...(defaults.searchableColumns ?? []),
        ...defaults.filterableColumns,
        ...defaults.sortableColumns,
        ...resolvedReadonly,
      ]) {
        if (!columns.includes(col)) {
          throw new Error(
            `[bunderstack] access.${key} references unknown column "${col}" on table "${name}"`,
          )
        }
      }

      resolved.set(key, {
        tableKey: key,
        tableName: name,
        enabled: true,
        ...defaults,
        readonlyColumns: resolvedReadonly,
      })
      continue
    }

    const ownerColumn = detectOwnerColumn(columns, input)
    const hasExplicitRules = input !== undefined
    const hasConventionOwner =
      ownerColumn !== undefined &&
      input?.ownerColumn === undefined &&
      columns.includes('userId')

    if (!hasExplicitRules && !hasConventionOwner) continue
    if (!ownerColumn && input?.crud !== true && !input?.scope) continue

    if (input?.ownerColumn && !columns.includes(input.ownerColumn)) {
      throw new Error(
        `[bunderstack] access.${key}.ownerColumn "${input.ownerColumn}" is not a column on table "${name}"`,
      )
    }

    const defaults = resolveDefaults(input ?? {}, ownerColumn, columns)
    const existingReadonly = defaults.readonlyColumns.filter((col) =>
      columns.includes(col),
    )
    const resolvedReadonly = [...new Set(existingReadonly)]

    for (const col of [
      ...(defaults.writableColumns ?? []),
      ...(defaults.searchableColumns ?? []),
      ...defaults.filterableColumns,
      ...defaults.sortableColumns,
      ...resolvedReadonly,
    ]) {
      if (!columns.includes(col)) {
        throw new Error(
          `[bunderstack] access.${key} references unknown column "${col}" on table "${name}"`,
        )
      }
    }

    const needsOwner = [defaults.update, defaults.delete].some(
      (r) => r === 'owner',
    )
    if (needsOwner && !ownerColumn) {
      throw new Error(
        `[bunderstack] access.${key} requires ownerColumn for owner-based update/delete rules`,
      )
    }

    resolved.set(key, {
      tableKey: key,
      tableName: name,
      enabled: true,
      ...defaults,
      readonlyColumns: resolvedReadonly,
    })
  }

  return resolved
}

export function defineAccess<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  rules: Record<string, TableAccessInput>,
): Record<string, TableAccessInput> {
  validateAndResolveAccess(schema, rules)
  return rules
}

export function rowMatchesScope(
  row: Record<string, unknown>,
  scope: ScopeMap,
): boolean {
  for (const [col, expected] of Object.entries(scope)) {
    const actual = row[col]
    if (actual == null) return false
    if (Array.isArray(expected)) {
      if (!expected.map(String).includes(String(actual))) return false
    } else if (String(actual) !== String(expected)) {
      return false
    }
  }
  return true
}

export function stampScope(
  values: Record<string, unknown>,
  scope: ScopeMap,
): Record<string, unknown> {
  const out = { ...values }
  for (const [col, expected] of Object.entries(scope)) {
    if (!Array.isArray(expected)) out[col] = expected
  }
  return out
}

export function checkAccessSync(
  rule: Exclude<
    OperationRule,
    (ctx: AccessContext) => boolean | Promise<boolean>
  >,
  ctx: AccessContext,
  ownerColumn?: string,
): { allowed: boolean } {
  if (rule === 'deny') return { allowed: false }
  if (rule === 'public') return { allowed: true }
  if (!ctx.user) return { allowed: false }
  if (rule === 'authenticated') return { allowed: true }
  if (rule === 'owner') {
    if (!ownerColumn) return { allowed: false }
    const owner = ctx.row?.[ownerColumn]
    return { allowed: owner != null && String(owner) === ctx.user.id }
  }
  return { allowed: false }
}

export async function checkAccess(
  rule: OperationRule,
  ctx: AccessContext,
  ownerColumn?: string,
): Promise<{ allowed: boolean; status: 401 | 403 }> {
  if (rule === 'deny') return { allowed: false, status: 403 }

  if (typeof rule === 'function') {
    return (await rule(ctx))
      ? { allowed: true, status: 403 }
      : { allowed: false, status: 403 }
  }

  if (rule === 'public') return { allowed: true, status: 403 }

  if (!ctx.user) return { allowed: false, status: 401 }

  if (rule === 'authenticated') return { allowed: true, status: 403 }

  if (rule === 'owner') {
    if (!ownerColumn) return { allowed: false, status: 403 }
    const rowOwner = ctx.row?.[ownerColumn] ?? ctx.body?.[ownerColumn]
    if (rowOwner == null) return { allowed: false, status: 403 }
    if (String(rowOwner) !== ctx.user.id) return { allowed: false, status: 403 }
    return { allowed: true, status: 403 }
  }

  return { allowed: false, status: 403 }
}

export function sanitizeWriteBody(
  body: Record<string, unknown>,
  access: ResolvedTableAccess,
  mode: 'create' | 'update',
  userId: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const readonly = new Set(access.readonlyColumns)

  for (const [key, value] of Object.entries(body)) {
    // On create, allow client-supplied `id` even if it appears in readonlyColumns,
    // but still respect an explicit writableColumns allowlist if provided.
    if (mode === 'create' && key === 'id') {
      if (access.writableColumns && !access.writableColumns.includes(key))
        continue
      out[key] = value
      continue
    }
    if (readonly.has(key)) continue
    if (access.writableColumns && !access.writableColumns.includes(key))
      continue
    out[key] = value
  }

  if (mode === 'create' && access.ownerColumn) {
    out[access.ownerColumn] = userId ?? null
  }

  if (mode === 'update' && access.ownerColumn) {
    delete out[access.ownerColumn]
  }

  return out
}

export type AuthSessionResolver = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{
      user: { id: string; email: string; name?: string } | null
      session?: { activeOrganizationId?: string | null } | null
    } | null>
  }
}

export async function resolveAccessUser(
  auth: AuthSessionResolver | undefined,
  headers: Headers,
): Promise<AccessUser | null> {
  if (!auth) return null
  const session = await auth.api.getSession({ headers })
  if (!session?.user) return null
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  }
}

export async function resolveSession(
  auth: AuthSessionResolver | undefined,
  headers: Headers,
): Promise<{ user: AccessUser | null; activeOrganizationId: string | null }> {
  if (!auth) return { user: null, activeOrganizationId: null }
  const session = await auth.api.getSession({ headers })
  if (!session?.user) return { user: null, activeOrganizationId: null }
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
    activeOrganizationId: session.session?.activeOrganizationId ?? null,
  }
}
