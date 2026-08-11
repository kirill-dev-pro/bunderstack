import { getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm'
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-valibot'
import '@orpc/openapi/extensions/route'
import * as v from 'valibot'

import type { AnyDb } from '../dialect'
import type { IdempotencyConfig } from '../idempotency'
import type { RealtimeFacade } from '../realtime/facade'
import type { CrudApiRouterFor } from './types'

import {
  tableEntryForName,
  type ResolvedAccess,
  type ResolvedTableAccess,
  type TableAccessInput,
} from '../access'
import { createCrudOperations, type CrudOperations } from '../crud-operations'
import { createApiBuilder } from './builder'

export type CrudApiRouterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
}

function strictObject<TEntries extends v.ObjectEntries>(schema: {
  entries: TEntries
}) {
  return v.strictObject(schema.entries)
}

type CrudInsert<TTable extends Table> = Partial<TTable['$inferInsert']>

export type BuildTableCrudProceduresArgs<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
> = {
  table: TTable
  operations: CrudOperations
  builder: ReturnType<typeof createApiBuilder<TSchema>>
  access: ResolvedTableAccess
}

export function buildTableCrudProcedures<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
>(args: BuildTableCrudProceduresArgs<TSchema, TTable>) {
  const { table, operations, builder, access } = args
  const name = getTableName(table)

  const selectSchema = strictObject(createSelectSchema(table))
  const generatedInsertSchema = strictObject(createInsertSchema(table))
  const generatedColumns = Object.keys(generatedInsertSchema.entries)
  const columns = getTableColumns(table)
  const serverManagedColumns = [
    ...access.readonlyColumns,
    ...(access.writeScope && generatedColumns.includes('organizationId')
      ? ['organizationId']
      : []),
    ...Object.entries(columns)
      .filter(([, column]) => !column.notNull || column.hasDefault)
      .map(([column]) => column),
  ].filter((column) => generatedColumns.includes(column))
  const insertEntries: Record<string, v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>> = {
    ...generatedInsertSchema.entries,
  }
  for (const column of serverManagedColumns) {
    const schema = insertEntries[column]
    if (schema) insertEntries[column] = v.optional(schema)
  }
  const insertSchema = v.strictObject(insertEntries) as unknown as v.GenericSchema<
    CrudInsert<TTable>,
    CrudInsert<TTable>
  >
  const generatedUpdateSchema = createUpdateSchema(table)
  const updateBodySchema = v.omit(generatedUpdateSchema, [
    'id' as keyof typeof generatedUpdateSchema.entries,
  ])
  const updateInputSchema = v.strictObject({
    params: v.strictObject({ id: v.string() }),
    query: v.optional(v.record(v.string(), v.unknown()), {}),
    headers: v.optional(v.record(v.string(), v.unknown()), {}),
    body: strictObject(updateBodySchema),
  })

  const listQuerySchema = v.optional(
    v.strictObject({
      limit: v.optional(
        v.pipe(
          v.union([v.string(), v.number()]),
          v.transform(Number),
          v.number(),
        ),
      ),
      offset: v.optional(v.number()),
      cursor: v.optional(v.string()),
      sort: v.optional(v.string()),
      order: v.optional(v.picklist(['asc', 'desc'])),
      q: v.optional(v.string()),
      count: v.optional(v.boolean()),
      filters: v.optional(v.record(v.string(), v.unknown())),
    }),
  )

  const listOutputSchema = v.strictObject({
    items: v.array(selectSchema),
    nextCursor: v.optional(v.string()),
    hasMore: v.boolean(),
    total: v.optional(v.number()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.string()),
    q: v.optional(v.string()),
    sort: v.optional(v.string()),
    order: v.optional(v.string()),
  })

  // 1. LIST procedure
  const list = builder.public
    .route({
      method: 'GET',
      path: `/api/${name}`,
      summary: `List ${name}`,
      tags: [name],
    })
    .input(listQuerySchema)
    .output(listOutputSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      const { filters, count, ...query } = input ?? {}
      const result = await operations.list(
        name,
        {
          ...query,
          ...(filters ?? {}),
          ...(count === undefined ? {} : { count: String(count) }),
        },
        execCtx,
      )
      return {
        ...result,
        items: result.items as TTable['$inferSelect'][],
      }
    })

  // 2. GET procedure
  const get = builder.public
    .route({
      method: 'GET',
      path: `/api/${name}/{id}`,
      summary: `Get ${name} by ID`,
      tags: [name],
    })
    .input(v.strictObject({ id: v.string() }))
    .output(selectSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      return (await operations.get(
        name,
        input.id,
        execCtx,
      )) as TTable['$inferSelect']
    })

  // 3. CREATE procedure
  const create = builder.public
    .route({
      method: 'POST',
      path: `/api/${name}`,
      summary: `Create ${name}`,
      tags: [name],
      successStatus: 201,
    })
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

      const res = await operations.create(
        name,
        input,
        rawBody,
        idempotencyKey,
        execCtx,
      )
      if (res.type === 'replay') {
        context.resHeaders.set('Idempotency-Replayed', 'true')
        return res.record as TTable['$inferSelect']
      }
      return res.record as TTable['$inferSelect']
    })

  // 4. UPDATE procedure
  const update = builder.public
    .route({
      method: 'PATCH',
      path: `/api/${name}/{id}`,
      summary: `Update ${name}`,
      tags: [name],
      inputStructure: 'detailed',
    })
    .input(updateInputSchema)
    .output(selectSchema)
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }

      return (await operations.update(
        name,
        input.params.id,
        input.body,
        execCtx,
      )) as TTable['$inferSelect']
    })

  // 5. DELETE procedure
  const deleteProc = builder.public
    .route({
      method: 'DELETE',
      path: `/api/${name}/{id}`,
      summary: `Delete ${name}`,
      tags: [name],
      successStatus: 204,
    })
    .input(v.strictObject({ id: v.string() }))
    .output(v.undefined())
    .handler(async ({ input, context }) => {
      const session = await context.getSession()
      const execCtx = {
        request: context.request,
        user: session.user,
        session: { activeOrganizationId: session.activeOrganizationId },
      }
      await operations.delete(name, input.id, execCtx)
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
      access: tableAccess,
    })

    routerObj[tableKey] = procedures
  }

  return routerObj as CrudApiRouterFor<TSchema, TAccess>
}
