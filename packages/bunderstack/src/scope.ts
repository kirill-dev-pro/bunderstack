import { and, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm'

import type { ScopeMap } from './access.ts'

export function buildScopeWhere(
  table: Parameters<typeof getTableColumns>[0],
  scope: ScopeMap,
): SQL | undefined {
  const columns = getTableColumns(table)
  const conditions: SQL[] = []
  for (const [name, value] of Object.entries(scope)) {
    const col = columns[name]
    if (!col) continue
    conditions.push(Array.isArray(value) ? inArray(col, value) : eq(col, value))
  }
  return conditions.length ? and(...conditions) : undefined
}
