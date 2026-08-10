import { getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm'
import { createSelectSchema, createInsertSchema } from 'drizzle-zod'
import { ORPCError } from '@orpc/server'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'

import {
  tableEntryForName,
  type ResolvedAccess,
  type TableAccessInput,
} from '../access'
import type { AnyDb } from '../dialect'
import {
  createCrudOperations,
  CrudOperationError,
  type CrudOperations,
} from '../crud-operations'
import type { IdempotencyConfig } from '../idempotency'
import type { RealtimeFacade } from '../realtime/facade'
import { createApiBuilder } from './builder'
import type { CrudApiRouterFor } from './types'

export type CrudApiRouterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
}

function omitIdShape<T extends Record<string, z.ZodTypeAny>>(
  shape: T,
): Omit<T, 'id'> {
  const rest: Record<string, z.ZodTypeAny> = {}
  for (const [k, v] of Object.entries(shape)) {
    if (k !== 'id') {
      rest[k] = v
    }
  }
  return rest as Omit<T, 'id'>
}

function toORPCError(err: CrudOperationError): ORPCError<any, any> {
  const codeMap: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
  }
  const code = codeMap[err.status] ?? 'INTERNAL_SERVER_ERROR'
  return new ORPCError(code as any, {
    message: err.message,
    data: {
      code: err.code,
      details: err.details,
    },
  })
}

export type BuildTableCrudProceduresArgs<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
> = {
  table: TTable
  operations: CrudOperations
  builder: ReturnType<typeof createApiBuilder<TSchema>>
}

export function buildTableCrudProcedures<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
>(args: BuildTableCrudProceduresArgs<TSchema, TTable>) {
  const { table, operations, builder } = args
  const name = getTableName(table)

  const selectSchema = createSelectSchema(table)
  const insertSchema = createInsertSchema(table)

  const updateInputSchema = z
    .object({ id: z.string() })
    .extend(omitIdShape(insertSchema.partial().shape))

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
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      try {
        const result = await operations.list(name, input, execCtx)
        return result as any
      } catch (err) {
        if (err instanceof CrudOperationError) {
          throw toORPCError(err)
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
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      try {
        return (await operations.get(name, input.id, execCtx)) as any
      } catch (err) {
        if (err instanceof CrudOperationError) {
          throw toORPCError(err)
        }
        throw err
      }
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
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      const idempotencyKey = context.request.headers
        .get('Idempotency-Key')
        ?.trim()
      const rawBody = await context.getRawBody()

      try {
        const res = await operations.create(
          name,
          input,
          rawBody,
          idempotencyKey,
          execCtx,
        )
        if (res.type === 'replay') {
          context.resHeaders.set('Idempotency-Replayed', 'true')
          return res.record as any
        }
        return res.record as any
      } catch (err) {
        if (err instanceof CrudOperationError) {
          throw toORPCError(err)
        }
        throw err
      }
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
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { id: rawId, ...body } = input as any
      try {
        return (await operations.update(name, rawId, body, execCtx)) as any
      } catch (err) {
        if (err instanceof CrudOperationError) {
          throw toORPCError(err)
        }
        throw err
      }
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
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      try {
        await operations.delete(name, input.id, execCtx)
        return undefined
      } catch (err) {
        if (err instanceof CrudOperationError) {
          throw toORPCError(err)
        }
        throw err
      }
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
  const { access, realtime, idempotency } = options
  const builder = createApiBuilder<TSchema>()
  const operations = createCrudOperations({
    schema,
    db,
    access,
    idempotency,
    realtime,
  })

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
      operations,
      builder,
    })

    routerObj[tableKey] = procedures
  }

  return routerObj as CrudApiRouterFor<TSchema, TAccess>
}
