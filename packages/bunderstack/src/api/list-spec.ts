import type { Table } from 'drizzle-orm'
import type * as v from 'valibot'

import { getTableColumns, getTableName } from 'drizzle-orm'

import type { ResolvedTableAccess } from '../access'
import type { ListParamsInput, ListResult } from '../list-query'

import { executeList, resolveListParams } from '../list-query'
import { buildListInputSchema } from './list-input-schema'

export type ListSpecOptions = {
  /** Columns a caller may filter on. Others are rejected by the schema. */
  filterable?: readonly string[]
  /** Columns a caller may sort on. Defaults to the default sort column. */
  sortable?: readonly string[]
  defaultSort?: { column: string; order: 'asc' | 'desc' }
  /** Columns the `q` parameter searches. */
  searchable?: readonly string[]
}

/**
 * The input schema and handler of a list endpoint, with the same filter, sort,
 * cursor, and count contract that the generated CRUD list uses.
 *
 * The caller applies both to its own base procedure:
 *
 * ```ts
 * const logsList = listSpec(appLogs, { filterable: ['level'] })
 * getLogs: adminProcedure.input(logsList.input).handler(logsList.handler)
 * ```
 *
 * The two parts are returned separately rather than as a finished procedure,
 * because a procedure built here would have to receive the builder as a
 * generic parameter. TypeScript resolves a method call on a generic parameter
 * through its constraint, which erases the input schema and the row type. With
 * this shape the builder stays concrete at the call site and keeps both.
 *
 * It reads no `access` configuration: the base procedure carries the policy.
 */
export function listSpec<TTable extends Table>(
  table: TTable,
  options: ListSpecOptions = {},
) {
  const defaultSort = options.defaultSort ?? { column: 'id', order: 'asc' }
  const sortableColumns = options.sortable ?? [defaultSort.column]

  const inputSchema = buildListInputSchema(table, {
    filterableColumns: options.filterable ?? [],
    sortableColumns,
  }) as unknown as v.GenericSchema<
    ListParamsInput | undefined,
    ListParamsInput | undefined
  >

  // `executeList` reads its policy from a resolved access record. This spec
  // declares that policy at the call site instead, because the base procedure
  // — not `access.ts` — carries the authorization for it.
  const access = {
    filterableColumns: options.filterable ?? [],
    sortableColumns,
    searchableColumns: options.searchable ?? [],
    defaultSort,
  } as unknown as ResolvedTableAccess

  const idColumn = getTableColumns(table).id
  if (!idColumn) {
    throw new Error(
      `[bunderstack] listSpec requires an "id" column on table "${getTableName(table)}"`,
    )
  }

  const handler = async (handlerOptions: {
    context: { db: unknown }
    input: ListParamsInput | undefined
  }): Promise<ListResult<TTable['$inferSelect']>> => {
    const params = resolveListParams(handlerOptions.input ?? {}, access)
    return executeList<TTable['$inferSelect']>(
      handlerOptions.context.db as never,
      table as never,
      access,
      params,
      idColumn,
    )
  }

  return { input: inputSchema, handler }
}
