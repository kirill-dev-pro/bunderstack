import { eq, getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm'
import type { AnyDb } from './dialect'
import type { RealtimeFacade } from './realtime/facade'
import {
  checkAccess,
  rowMatchesScope,
  sanitizeWriteBody,
  stampScope,
  tableEntryForName,
  type AccessUser,
  type ResolvedAccess,
  type ResolvedTableAccess,
  type ScopeMap,
  type ScopeResolver,
} from './access'
import { ErrorCode, ListQueryError, type ErrorCodeValue } from './errors'
import {
  lookupIdempotency,
  resolveIdempotencyConfig,
  storeIdempotency,
  type IdempotencyConfig,
} from './idempotency'
import { executeList, parseListParams, type ListResult } from './list-query'
import { buildScopeWhere } from './scope'

export interface CrudExecutionContext {
  request: Request
  user: AccessUser | null
  session: { activeOrganizationId: string | null }
}

export class CrudOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCodeValue,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'CrudOperationError'
  }
}

export type CrudOperationsDeps<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  schema: TSchema
  db: AnyDb
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
}

export type CreateResult =
  | { type: 'created'; status: 201; record: Record<string, unknown> }
  | { type: 'replay'; status: number; body: string; record: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function coerceId(rawId: string | number): string | number {
  if (typeof rawId === 'number') return rawId
  return isNaN(Number(rawId)) ? rawId : Number(rawId)
}

export function createCrudOperations<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>(deps: CrudOperationsDeps<TSchema>) {
  const { schema, db, access, realtime } = deps
  const idempotency = resolveIdempotencyConfig(deps.idempotency)

  const scopeFor = (
    resolver: ScopeResolver | undefined,
    ctx: {
      user: AccessUser | null
      session: { activeOrganizationId: string | null }
      request: Request
      row?: Record<string, unknown>
      body?: Record<string, unknown>
    },
  ): ScopeMap | undefined => (resolver ? resolver(ctx) : undefined)

  function resolveTable(tableName: string) {
    const table = Object.values(schema).find(
      (t) => isTable(t) && getTableName(t) === tableName,
    ) as Table | undefined
    if (!table) {
      throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
    }
    const tableAccess = tableEntryForName(access, tableName)
    if (!tableAccess || !tableAccess.enabled) {
      throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
    }
    const idCol = getTableColumns(table)['id']
    if (!idCol) {
      throw new CrudOperationError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Table ${tableName} has no id column`,
      )
    }
    return { table, tableAccess, idCol }
  }

  return {
    async list(
      tableName: string,
      paramsInput: URL | Record<string, unknown> | undefined,
      ctx: CrudExecutionContext,
    ): Promise<ListResult<Record<string, unknown>>> {
      const { table, tableAccess, idCol } = resolveTable(tableName)

      const denied = await checkAccess(tableAccess.list, ctx, tableAccess.ownerColumn)
      if (!denied.allowed) {
        throw new CrudOperationError(
          denied.status === 401 ? 401 : 403,
          ErrorCode.FORBIDDEN,
          'Forbidden',
        )
      }

      let urlObj: URL
      if (paramsInput instanceof URL) {
        urlObj = paramsInput
      } else {
        urlObj = new URL(ctx.request.url || 'http://localhost')
        if (paramsInput) {
          for (const [k, v] of Object.entries(paramsInput)) {
            if (v !== undefined && v !== null) {
              urlObj.searchParams.set(k, String(v))
            }
          }
        }
      }

      try {
        const params = parseListParams(urlObj, tableAccess)
        const scope = scopeFor(tableAccess.readScope, ctx)
        const scopeWhere = scope ? buildScopeWhere(table, scope) : undefined
        return await executeList(
          db,
          table,
          tableAccess,
          params,
          idCol,
          scopeWhere,
        )
      } catch (err) {
        if (err instanceof ListQueryError) {
          throw new CrudOperationError(400, err.code, err.message, err.details)
        }
        throw err
      }
    },

    async get(
      tableName: string,
      rawId: string | number,
      ctx: CrudExecutionContext,
    ): Promise<Record<string, unknown>> {
      const { table, tableAccess, idCol } = resolveTable(tableName)
      const id = coerceId(rawId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!rows[0]) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }
      const row = rows[0] as Record<string, unknown>

      const denied = await checkAccess(
        tableAccess.get,
        { ...ctx, row },
        tableAccess.ownerColumn,
      )
      if (!denied.allowed) {
        throw new CrudOperationError(
          denied.status === 401 ? 401 : 403,
          ErrorCode.FORBIDDEN,
          'Forbidden',
        )
      }

      const scope = scopeFor(tableAccess.readScope, ctx)
      if (scope && !rowMatchesScope(row, scope)) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }

      return row
    },

    async create(
      tableName: string,
      body: unknown,
      rawBody: string | undefined,
      idempotencyKey: string | undefined,
      ctx: CrudExecutionContext,
    ): Promise<CreateResult> {
      const { table, tableAccess } = resolveTable(tableName)

      const denied = await checkAccess(tableAccess.create, ctx, tableAccess.ownerColumn)
      if (!denied.allowed) {
        throw new CrudOperationError(
          denied.status === 401 ? 401 : 403,
          ErrorCode.FORBIDDEN,
          'Forbidden',
        )
      }

      if (!isRecord(body)) {
        throw new CrudOperationError(
          400,
          ErrorCode.VALIDATION_ERROR,
          'Invalid JSON body',
        )
      }

      const trimmedKey = idempotencyKey?.trim()
      const effectiveRawBody = rawBody ?? JSON.stringify(body)

      if (idempotency && trimmedKey) {
        const lookup = await lookupIdempotency(
          db,
          tableName,
          trimmedKey,
          effectiveRawBody,
          idempotency,
        )
        if (lookup.type === 'conflict') {
          throw new CrudOperationError(
            409,
            ErrorCode.IDEMPOTENCY_CONFLICT,
            'Idempotency key reused with different body',
          )
        }
        if (lookup.type === 'replay') {
          return {
            type: 'replay',
            status: lookup.status,
            body: lookup.response,
            record: JSON.parse(lookup.response) as Record<string, unknown>,
          }
        }
      }

      const values = sanitizeWriteBody(
        body,
        tableAccess,
        'create',
        ctx.user?.id ?? null,
      )

      const scope = scopeFor(tableAccess.writeScope, { ...ctx, body })
      const stamped = scope ? stampScope(values, scope) : values

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).insert(table).values(stamped).returning()
      const created = rows[0] as Record<string, unknown>
      void realtime?.publish(table as never, 'create', created as never)

      if (idempotency && trimmedKey) {
        await storeIdempotency(
          db,
          tableName,
          trimmedKey,
          effectiveRawBody,
          201,
          created,
          idempotency,
        )
      }

      return {
        type: 'created',
        status: 201,
        record: created,
      }
    },

    async update(
      tableName: string,
      rawId: string | number,
      body: unknown,
      ctx: CrudExecutionContext,
    ): Promise<Record<string, unknown>> {
      const { table, tableAccess, idCol } = resolveTable(tableName)
      const id = coerceId(rawId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }
      const existingRow = existing[0] as Record<string, unknown>

      const readScope = scopeFor(tableAccess.readScope, ctx)
      if (readScope && !rowMatchesScope(existingRow, readScope)) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }

      const denied = await checkAccess(
        tableAccess.update,
        { ...ctx, row: existingRow },
        tableAccess.ownerColumn,
      )
      if (!denied.allowed) {
        throw new CrudOperationError(
          denied.status === 401 ? 401 : 403,
          ErrorCode.FORBIDDEN,
          'Forbidden',
        )
      }

      if (!isRecord(body)) {
        throw new CrudOperationError(
          400,
          ErrorCode.VALIDATION_ERROR,
          'Invalid JSON body',
        )
      }

      const values = sanitizeWriteBody(
        body,
        tableAccess,
        'update',
        ctx.user?.id ?? null,
      )

      const writeScope = scopeFor(tableAccess.writeScope, { ...ctx, body })
      const stamped = writeScope ? stampScope(values, writeScope) : values

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any)
        .update(table)
        .set(stamped)
        .where(eq(idCol as any, id))
        .returning()

      if (!rows[0]) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }
      const updated = rows[0] as Record<string, unknown>
      void realtime?.publish(table as never, 'update', updated as never)
      return updated
    },

    async delete(
      tableName: string,
      rawId: string | number,
      ctx: CrudExecutionContext,
    ): Promise<void> {
      const { table, tableAccess, idCol } = resolveTable(tableName)
      const id = coerceId(rawId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }
      const existingRow = existing[0] as Record<string, unknown>

      const readScope = scopeFor(tableAccess.readScope, ctx)
      if (readScope && !rowMatchesScope(existingRow, readScope)) {
        throw new CrudOperationError(404, ErrorCode.NOT_FOUND, 'Not found')
      }

      const denied = await checkAccess(
        tableAccess.delete,
        { ...ctx, row: existingRow },
        tableAccess.ownerColumn,
      )
      if (!denied.allowed) {
        throw new CrudOperationError(
          denied.status === 401 ? 401 : 403,
          ErrorCode.FORBIDDEN,
          'Forbidden',
        )
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).delete(table).where(eq(idCol as any, id))
      void realtime?.publish(table as never, 'delete', existingRow as never)
    },
  }
}

export type CrudOperations = ReturnType<typeof createCrudOperations>
