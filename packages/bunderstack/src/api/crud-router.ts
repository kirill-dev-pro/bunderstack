import { getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm'
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-valibot'
import '@orpc/openapi/extensions/route'
import { eventIterator } from '@orpc/server'
import * as v from 'valibot'

import type { AnyDb } from '../dialect'
import type { IdempotencyConfig } from '../idempotency'
import type { LiveSnapshotFrame } from '../live/protocol'
import type { RealtimeFacade } from '../realtime/facade'
import type { RealtimePublisher } from '../realtime/publisher'
import type { CrudApiRouterFor } from './types'

import {
  tableEntryForName,
  type ResolvedAccess,
  type ResolvedTableAccess,
  type TableAccessInput,
} from '../access'
import { createCrudOperations, type CrudOperations } from '../crud-operations'
import { filterTableChanges } from '../realtime/filter'
import {
  REALTIME_HEARTBEAT_INTERVAL_MS,
  withRealtimeHeartbeat,
} from '../realtime/heartbeat'
import { createApiBuilder } from './builder'
import { createLiveWindow } from './live-window'
import { buildListInputSchema, buildLiveInputSchema } from './list-input-schema'

export type CrudApiRouterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
  /**
   * The raw realtime publisher, present when realtime is enabled. The CRUD
   * router subscribes on behalf of live views (`GET /{table}:live`);
   * publishing stays behind the facade.
   */
  livePublisher?: RealtimePublisher
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

export type ListFilters<TTable extends Table, TFilterable extends string> = {
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

/**
 * The live-view input as callers see it: the list contract narrowed to what a
 * stream can honor — no text search, no pagination.
 */
export type LiveInputFor<
  TTable extends Table,
  TFilterable extends string,
  TSortable extends string,
> =
  | {
      limit?: number
      sort?: TSortable
      order?: 'asc' | 'desc'
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
  /** The schema key events are published under. */
  schemaKey: string
  /** Present when realtime is enabled; without it no live procedure is built. */
  livePublisher?: RealtimePublisher
}

export function buildTableCrudProcedures<
  TSchema extends Record<string, unknown>,
  TTable extends Table,
  TFilterable extends string = string,
  TSortable extends string = string,
>(args: BuildTableCrudProceduresArgs<TSchema, TTable>) {
  const { table, operations, builder, access, schemaKey, livePublisher } =
    args
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
  const insertEntries: Record<
    string,
    v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
  > = {
    ...generatedInsertSchema.entries,
  }
  for (const column of serverManagedColumns) {
    const schema = insertEntries[column]
    if (schema) insertEntries[column] = v.optional(schema)
  }
  const insertSchema = v.strictObject(
    insertEntries,
  ) as unknown as v.GenericSchema<CrudInsert<TTable>, CrudInsert<TTable>>
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
  // The cast restates the schema with the literals the caller's `access`
  // config carries, which the runtime column lists cannot name on their own.
  const listQuerySchema = buildListInputSchema(table, {
    filterableColumns: access.filterableColumns,
    sortableColumns: access.sortableColumns,
  }) as unknown as v.GenericSchema<
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

  // 6. LIVE procedure — one list query as a stream. A snapshot first, then the
  // changes this view cares about, placed by the server. Every connection
  // opens with a snapshot, so a reconnect is its own recovery: no client-side
  // event buffer, no Last-Event-ID bookkeeping, and no refetch path.
  const liveQuerySchema = buildLiveInputSchema(table, {
    filterableColumns: access.filterableColumns,
    sortableColumns: access.sortableColumns,
  }) as unknown as v.GenericSchema<
    LiveInputFor<TTable, TFilterable, TSortable>,
    LiveInputFor<TTable, TFilterable, TSortable>
  >

  const recordSchema = v.record(v.string(), v.unknown())
  const liveFrameSchema = v.union([
    v.strictObject({
      type: v.literal('snapshot'),
      items: v.array(recordSchema),
      sort: v.string(),
      order: v.picklist(['asc', 'desc']),
      limit: v.number(),
      hasMore: v.boolean(),
    }),
    v.strictObject({
      type: v.literal('upsert'),
      record: recordSchema,
      afterId: v.union([v.string(), v.null()]),
    }),
    v.strictObject({ type: v.literal('remove'), id: v.string() }),
    v.strictObject({ type: v.literal('heartbeat'), intervalMs: v.number() }),
  ])

  const live = !livePublisher
    ? undefined
    : builder.public
        .route({
          method: 'GET',
          // A path of its own, not a child of the table: `/{table}/live`
          // would make the id "live" unreachable on the get route, and a
          // colon suffix is a wildcard parameter in the oRPC matcher.
          path: `/api/live/${name}`,
          summary: `Live view of ${name}`,
          tags: [name],
          // Filters arrive as one URL-encoded JSON value, so no per-key query
          // parsing rule is needed.
          queryStyles: { filters: 'json' },
        })
        .input(liveQuerySchema)
        .output(eventIterator(liveFrameSchema))
        .handler(({ input, context, signal }) => {
          // Subscribe before anything awaits, so no change slips between the
          // snapshot read and the start of the stream; events that arrive
          // during the query buffer in the publisher and replay on first pull.
          const changes = filterTableChanges(
            livePublisher.subscribe('change', { signal }),
            {
              tableName: schemaKey,
              entry: access,
              rule: access.list,
              request: context.request,
              getSession: context.getSession,
            },
          )

          return withRealtimeHeartbeat(
            (async function* () {
              const session = await context.getSession()
              const execCtx = {
                request: context.request,
                user: session.user,
                session: { activeOrganizationId: session.activeOrganizationId },
              }
              let view: ReturnType<typeof createLiveWindow> | undefined

              const readSnapshot = async (): Promise<LiveSnapshotFrame> => {
                const result = await operations.list(name, input ?? {}, execCtx)
                view = createLiveWindow({
                  sort: result.sort,
                  order: result.order,
                  limit: result.limit,
                  filters: input?.filters as
                    | Record<string, unknown>
                    | undefined,
                })
                view.reset(result.items, result.hasMore)
                return {
                  type: 'snapshot',
                  items: result.items,
                  sort: result.sort,
                  order: result.order,
                  limit: result.limit,
                  hasMore: result.hasMore,
                }
              }

              yield await readSnapshot()

              for await (const change of changes) {
                const outcome = view!.apply(change)
                if (outcome.type === 'none') continue
                if (outcome.type === 'resnapshot') {
                  yield await readSnapshot()
                  continue
                }
                for (const frame of outcome.frames) yield frame
              }
            })(),
            { intervalMs: REALTIME_HEARTBEAT_INTERVAL_MS, signal },
          )
        })

  return {
    list,
    get,
    create,
    update,
    delete: deleteProc,
    ...(live ? { live } : {}),
  } as {
    list: typeof list
    get: typeof get
    create: typeof create
    update: typeof update
    delete: typeof deleteProc
    live?: NonNullable<typeof live>
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
  const { access, realtime, idempotency, livePublisher } = options
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
      schemaKey: tableKey,
      livePublisher,
    })

    routerObj[tableKey] = procedures
  }

  return routerObj as CrudApiRouterFor<TSchema, TAccess>
}
