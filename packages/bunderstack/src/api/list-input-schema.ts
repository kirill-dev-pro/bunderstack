import type { Table } from 'drizzle-orm'

import { createSelectSchema } from 'drizzle-valibot'
import * as v from 'valibot'

import { MAX_LIST_LIMIT } from '../list-query'

/**
 * One filter field per allowed column, typed by the column itself: a scalar
 * for `=`, a list for `IN`, and `null` for `IS NULL`. Query strings are
 * coerced to these types by SmartCoercionHandlerPlugin, so REST and RPC share
 * one contract and nothing has to re-read the raw URL.
 */
function buildFilterEntries(
  table: Table,
  filterableColumns: readonly string[],
): v.ObjectEntries {
  const selectEntries = createSelectSchema(table).entries as Record<
    string,
    v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
  >
  const filterEntries: v.ObjectEntries = {}
  for (const column of filterableColumns) {
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
  return filterEntries
}

/**
 * The input contract every list endpoint shares. Built from runtime column
 * lists, so the schema's own inferred type cannot name the columns; callers
 * restate it with the literals their configuration carries. Runtime shape and
 * the restated type are the same object.
 */
export function buildListInputSchema(
  table: Table,
  options: {
    filterableColumns: readonly string[]
    sortableColumns: readonly string[]
  },
) {
  const filterEntries = buildFilterEntries(table, options.filterableColumns)

  return v.optional(
    v.strictObject({
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      cursor: v.optional(v.string()),
      sort: v.optional(v.picklist(options.sortableColumns as string[])),
      order: v.optional(v.picklist(['asc', 'desc'])),
      q: v.optional(v.pipe(v.string(), v.maxLength(100))),
      count: v.optional(v.boolean()),
      // Always present, even with no filterable columns: clients send `{}`.
      filters: v.optional(v.strictObject(filterEntries)),
    }),
  )
}
