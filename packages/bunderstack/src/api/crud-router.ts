import { eq, getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm'
import { createSelectSchema, createInsertSchema } from 'drizzle-zod'
import { os, ORPCError } from '@orpc/server'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'

import {
  checkAccess,
  rowMatchesScope,
  sanitizeWriteBody,
  stampScope,
  tableEntryForName,
  type AccessContext,
  type CrudOperation,
  type ResolvedAccess,
  type ResolvedTableAccess,
  type ScopeMap,
  type ScopeResolver,
  type TableAccessInput,
} from '../access'
import type { AnyDb } from '../dialect'
import { ListQueryError } from '../errors'
import {
  lookupIdempotency,
  resolveIdempotencyConfig,
  storeIdempotency,
  type IdempotencyConfig,
} from '../idempotency'
import { executeList, parseListParams } from '../list-query'
import type { RealtimeFacade } from '../realtime/facade'
import { buildScopeWhere } from '../scope'
import { createApiBuilder } from './builder'
import type { CrudApiRouterFor } from './types'

export type CrudApiRouterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
}

async function enforce(
  operation: CrudOperation,
  access: ResolvedTableAccess,
  ctx: Parameters<typeof checkAccess>[1],
) {
  const rule = access[operation]
  return await checkAccess(rule, ctx, access.ownerColumn)
}

function scopeFor(
  resolver: ScopeResolver | undefined,
  ctx: AccessContext,
): ScopeMap | undefined {
  return resolver ? resolver(ctx) : undefined
}

export type BuildTableCrudProceduresArgs<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
> = {
  table: TTable
  tableAccess: ResolvedTableAccess
  db: AnyDb
  idempotency: IdempotencyConfig | null
  realtime?: RealtimeFacade<TSchema>
  builder: ReturnType<typeof createApiBuilder<TSchema>>
}

function getZodObjectSchema(schema: z.ZodTypeAny): z.ZodObject<any> | undefined {
  if (schema instanceof z.ZodObject) return schema
  if (schema && typeof schema === 'object' && 'shape' in schema && typeof (schema as any).shape === 'object') {
    return schema as any
  }
  if (schema && typeof schema === 'object' && '_def' in schema && (schema as any)._def) {
    const def = (schema as any)._def
    if (def.schema) return getZodObjectSchema(def.schema)
    if (def.in) return getZodObjectSchema(def.in)
    if (def.out) return getZodObjectSchema(def.out)
  }
  return undefined
}

export function buildTableCrudProcedures<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
>(args: BuildTableCrudProceduresArgs<TSchema, TTable>) {
  const { table, tableAccess, db, idempotency, realtime, builder } = args
  const name = getTableName(table)
  const idCol = getTableColumns(table)['id']

  const selectSchema = createSelectSchema(table)
  const insertSchema = createInsertSchema(table)

  const rawInsertObject = getZodObjectSchema(insertSchema as any)
  const mutableUpdateShape: Record<string, z.ZodTypeAny> = {}
  if (rawInsertObject) {
    const { id: _id, ...restShape } = rawInsertObject.shape
    for (const [k, v] of Object.entries(restShape)) {
      mutableUpdateShape[k] = (v as z.ZodTypeAny).optional()
    }
  } else {
    for (const colName of Object.keys(getTableColumns(table))) {
      if (colName !== 'id') {
        mutableUpdateShape[colName] = z.any().optional()
      }
    }
  }

  const updateInputSchema = z.object({
    id: z.string(),
    ...mutableUpdateShape,
  })

  const listQuerySchema = z
    .object({
      limit: z.coerce.number().optional(),
      cursor: z.string().optional(),
      sort: z.string().optional(),
      filter: z.string().optional(),
      count: z.enum(['true', 'false']).optional(),
    })
    .optional()

  const listOutputSchema = z.object({
    items: z.array(selectSchema),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
    total: z.number().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    cursor: z.string().optional(),
    q: z.string().optional(),
    sort: z.string().optional(),
    order: z.string().optional(),
  })

  // 1. LIST procedure
  const list = builder.public
    .meta(
      openapi({
        method: 'GET',
        path: `/api/${name}`,
        summary: `List ${name}`,
      }),
    )
    .input(listQuerySchema)
    .output(listOutputSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const user = session.user
      const activeOrganizationId = session.activeOrganizationId
      const accessSession = { activeOrganizationId }

      const denied = await enforce('list', tableAccess, {
        user,
        session: accessSession,
        request: context.request,
      })
      if (!denied.allowed) {
        throw new ORPCError(
          denied.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          { message: 'Forbidden' },
        )
      }

      try {
        const urlObj = new URL(context.request.url)
        if (input) {
          if (input.limit !== undefined)
            urlObj.searchParams.set('limit', String(input.limit))
          if (input.cursor) urlObj.searchParams.set('cursor', input.cursor)
          if (input.sort) urlObj.searchParams.set('sort', input.sort)
          if (input.filter) urlObj.searchParams.set('filter', input.filter)
          if (input.count) urlObj.searchParams.set('count', input.count)
        }

        const params = parseListParams(urlObj, tableAccess)
        const scope = scopeFor(tableAccess.readScope, {
          user,
          session: accessSession,
          request: context.request,
        })
        const scopeWhere = scope ? buildScopeWhere(table, scope) : undefined
        const result = await executeList(
          db,
          table,
          tableAccess,
          params,
          idCol,
          scopeWhere,
        )
        return result as any
      } catch (err) {
        if (err instanceof ListQueryError) {
          throw new ORPCError('BAD_REQUEST', {
            message: err.message,
            data: err.details,
          })
        }
        throw err
      }
    })

  // 2. GET procedure
  const get = builder.public
    .meta(
      openapi({
        method: 'GET',
        path: `/api/${name}/{id}`,
        summary: `Get ${name} by ID`,
      }),
    )
    .input(z.object({ id: z.string() }))
    .output(selectSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const user = session.user
      const activeOrganizationId = session.activeOrganizationId
      const accessSession = { activeOrganizationId }

      const rawId = input.id
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)

      const rows = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!rows[0]) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      const denied = await enforce('get', tableAccess, {
        user,
        session: accessSession,
        request: context.request,
        row: rows[0] as Record<string, unknown>,
      })
      if (!denied.allowed) {
        throw new ORPCError(
          denied.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          { message: 'Forbidden' },
        )
      }

      const scope = scopeFor(tableAccess.readScope, {
        user,
        session: accessSession,
        request: context.request,
      })
      if (
        scope &&
        !rowMatchesScope(rows[0] as Record<string, unknown>, scope)
      ) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      return rows[0]
    })

  // 3. CREATE procedure
  const create = builder.public
    .meta(
      openapi({
        method: 'POST',
        path: `/api/${name}`,
        summary: `Create ${name}`,
        successStatus: 201,
      }),
    )
    .input(insertSchema)
    .output(selectSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const user = session.user
      const activeOrganizationId = session.activeOrganizationId
      const accessSession = { activeOrganizationId }

      const denied = await enforce('create', tableAccess, {
        user,
        session: accessSession,
        request: context.request,
      })
      if (!denied.allowed) {
        throw new ORPCError(
          denied.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          { message: 'Forbidden' },
        )
      }

      const idempotencyKey = context.request.headers
        .get('Idempotency-Key')
        ?.trim()
      const rawBody = JSON.stringify(input)
      if (idempotency && idempotencyKey) {
        const lookup = await lookupIdempotency(
          db,
          name,
          idempotencyKey,
          rawBody,
          idempotency,
        )
        if (lookup.type === 'conflict') {
          throw new ORPCError('CONFLICT', {
            message: 'Idempotency key reused with different body',
          })
        }
        if (lookup.type === 'replay') {
          return JSON.parse(lookup.response)
        }
      }

      const values = sanitizeWriteBody(
        input,
        tableAccess,
        'create',
        user?.id ?? null,
      )

      const scope = scopeFor(tableAccess.writeScope, {
        user,
        session: accessSession,
        request: context.request,
        body: input as Record<string, unknown>,
      })
      const stamped = scope ? stampScope(values, scope) : values

      const rows = await (db as any)
        .insert(table)
        .values(stamped)
        .returning()
      const created = rows[0]
      void realtime?.publish(table as never, 'create', created as never)

      if (idempotency && idempotencyKey) {
        await storeIdempotency(
          db,
          name,
          idempotencyKey,
          rawBody,
          201,
          created,
          idempotency,
        )
      }

      return created
    })

  // 4. UPDATE procedure
  const update = builder.public
    .meta(
      openapi({
        method: 'PATCH',
        path: `/api/${name}/{id}`,
        summary: `Update ${name}`,
      }),
    )
    .input(updateInputSchema)
    .output(selectSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const user = session.user
      const activeOrganizationId = session.activeOrganizationId
      const accessSession = { activeOrganizationId }

      const { id: rawId, ...body } = input as any
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)

      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      const readScope = scopeFor(tableAccess.readScope, {
        user,
        session: accessSession,
        request: context.request,
      })
      if (
        readScope &&
        !rowMatchesScope(existing[0] as Record<string, unknown>, readScope)
      ) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      const denied = await enforce('update', tableAccess, {
        user,
        session: accessSession,
        request: context.request,
        row: existing[0] as Record<string, unknown>,
      })
      if (!denied.allowed) {
        throw new ORPCError(
          denied.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          { message: 'Forbidden' },
        )
      }

      const values = sanitizeWriteBody(
        body,
        tableAccess,
        'update',
        user?.id ?? null,
      )

      const writeScope = scopeFor(tableAccess.writeScope, {
        user,
        session: accessSession,
        request: context.request,
        body,
      })
      const stamped = writeScope ? stampScope(values, writeScope) : values

      const rows = await (db as any)
        .update(table)
        .set(stamped)
        .where(eq(idCol as any, id))
        .returning()
      if (!rows[0]) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      void realtime?.publish(table as never, 'update', rows[0] as never)
      return rows[0]
    })

  // 5. DELETE procedure
  const deleteProc = builder.public
    .meta(
      openapi({
        method: 'DELETE',
        path: `/api/${name}/{id}`,
        summary: `Delete ${name}`,
        successStatus: 204,
      }),
    )
    .input(z.object({ id: z.string() }))
    .output(z.undefined())
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const user = session.user
      const activeOrganizationId = session.activeOrganizationId
      const accessSession = { activeOrganizationId }

      const rawId = input.id
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)

      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      const scope = scopeFor(tableAccess.readScope, {
        user,
        session: accessSession,
        request: context.request,
      })
      if (
        scope &&
        !rowMatchesScope(existing[0] as Record<string, unknown>, scope)
      ) {
        throw new ORPCError('NOT_FOUND', { message: 'Not found' })
      }

      const denied = await enforce('delete', tableAccess, {
        user,
        session: accessSession,
        request: context.request,
        row: existing[0] as Record<string, unknown>,
      })
      if (!denied.allowed) {
        throw new ORPCError(
          denied.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          { message: 'Forbidden' },
        )
      }

      await (db as any).delete(table).where(eq(idCol as any, id))
      void realtime?.publish(table as never, 'delete', existing[0] as never)
      return undefined
    })

  return {
    list,
    get,
    create,
    update,
    delete: deleteProc,
  }
}

export type TableCrudProcedures<TTable extends Table> = ReturnType<
  typeof buildTableCrudProcedures<Record<string, unknown>, TTable>
>

export function buildCrudApiRouter<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = undefined,
>(
  schema: TSchema,
  db: AnyDb,
  options: CrudApiRouterOptions<TSchema>,
): CrudApiRouterFor<TSchema, TAccess> {
  const { access, realtime } = options
  const idempotency = resolveIdempotencyConfig(options.idempotency)
  const builder = createApiBuilder<TSchema>()

  const routerObj: Record<string, unknown> = {}

  for (const [tableKey, table] of Object.entries(schema)) {
    if (!isTable(table)) continue

    const name = getTableName(table)
    const tableAccess = tableEntryForName(access, name)
    if (!tableAccess?.enabled) continue

    const idCol = getTableColumns(table)['id']
    if (!idCol) continue

    const procedures = buildTableCrudProcedures({
      table: table as Table,
      tableAccess,
      db,
      idempotency,
      realtime,
      builder,
    })

    routerObj[tableKey] = procedures
  }

  return routerObj as CrudApiRouterFor<TSchema, TAccess>
}
