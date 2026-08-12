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
import { MAX_LIST_LIMIT } from '../list-query'
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
type CrudUpdate<TTable extends Table> = Partial<
  Omit<TTable['$inferInsert'], 'id'>
>

/** A filter accepts one value (`=`), a list (`IN`), or null (`IS NULL`). */
export type ListFilterValue<T> = T | readonly T[] | null | 'null'

export type ListFilters<
  TTable extends Table,
  TFilterable extends string,
> = {
  [K in Extract<keyof TTable['$inferSelect'], TFilterable>]?: ListFilterValue<
    TTable['$inferSelect'][K]
  >
}

/**
 * The `list` input as callers see it. Filter columns and sortable columns come
 * from the table's `access` entry, so `filters` autocompletes to real columns
 * and rejects wrong value types at compile time.
 */
export type ListInputFor<
  TTable extends Table,
  TFilterable extends string,
  TSortable extends string,
> =
  | {
      limit?: number
      offset?: number
      cursor?: string
      sort?: TSortable
      order?: 'asc' | 'desc'
      q?: string
      count?: boolean
      filters?: ListFilters<TTable, TFilterable>
    }
  | undefined

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
  TFilterable extends string = string,
  TSortable extends string = string,
>(args: BuildTableCrudProceduresArgs<TSchema, TTable>) {
  const { table, operations, builder, access } = args
  const name = getTableName(table)

  // drizzle-valibot infers its schemas through internal generics. Left as-is,
  // declaration emit inlines those generics by name into the published `.d.ts`,
  // where they are unbound — every column silently becomes optional for the
  // consumer. Restating the type keeps the runtime schema and makes the emitted
  // one both correct and readable.
  const selectSchema = strictObject(
    createSelectSchema(table),
  ) as unknown as v.GenericSchema<
    TTable['$inferSelect'],
    TTable['$inferSelect']
  >
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
    // Same reason as `selectSchema`: state the type instead of letting
    // declaration emit inline drizzle-valibot's generics.
    body: strictObject(updateBodySchema) as unknown as v.GenericSchema<
      CrudUpdate<TTable>,
      CrudUpdate<TTable>
    >,
  })

  // One filter field per allowed column, typed by the column itself: a scalar
  // for `=`, a list for `IN`, and `null` for `IS NULL`. Query strings are
  // coerced to these types by SmartCoercionHandlerPlugin, so REST and RPC share
  // one contract and nothing has to re-read the raw URL.
  const selectEntries = createSelectSchema(table).entries as Record<
    string,
    v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
  >
  const filterEntries: v.ObjectEntries = {}
  for (const column of access.filterableColumns) {
    const base = selectEntries[column]
    if (!base) continue
    filterEntries[column] = v.optional(
      v.union([
        // `?filters[col]=null` — a query string cannot carry a real null.
        v.pipe(
          v.literal('null'),
          v.transform(() => null),
        ),
        base,
        v.pipe(v.array(base), v.maxLength(MAX_LIST_LIMIT)),
        v.null(),
      ]),
    )
  }

  // Built from runtime column lists, so the schema's own inferred type cannot
  // name the columns; the cast restates it with the literals the caller's
  // `access` config carries. Runtime shape and this type are the same object.
  const listQuerySchema = v.optional(
    v.strictObject({
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      cursor: v.optional(v.string()),
      sort: v.optional(v.picklist(access.sortableColumns)),
      order: v.optional(v.picklist(['asc', 'desc'])),
      q: v.optional(v.pipe(v.string(), v.maxLength(100))),
      count: v.optional(v.boolean()),
      // Always present, even with no filterable columns: clients send `{}`.
      filters: v.optional(v.strictObject(filterEntries)),
    }),
  ) as unknown as v.GenericSchema<
    ListInputFor<TTable, TFilterable, TSortable>,
    ListInputFor<TTable, TFilterable, TSortable>
  >


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
      const result = await operations.list(name, input ?? {}, execCtx)
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

export type TableCrudProcedures<
  TTable extends Table,
  TFilterable extends string = string,
  TSortable extends string = string,
> = ReturnType<
  typeof buildTableCrudProcedures<
    Record<string, unknown>,
    TTable,
    TFilterable,
    TSortable
  >
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
