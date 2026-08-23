/**
 * Server-side membership for a live view: does one record belong to a view,
 * given that view's filters?
 *
 * The rule is evaluated per streamed record, so a change is routed to the
 * views that want it without asking the database.
 */

/** Same value semantics as list filters: dates by time, the rest by identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Bunderstack's filter contract — a scalar is `=`, an array is `IN`, `null` is
 * `IS NULL` — evaluated against one record. The string `'null'` means the same
 * as `null`, because a query string cannot carry a real null.
 */
export function matchesLiveFilters(
  record: Record<string, unknown>,
  filters: Record<string, unknown> | undefined,
): boolean {
  for (const [column, expected] of Object.entries(filters ?? {})) {
    if (expected === undefined) continue
    const actual = record[column]
    if (expected === null || expected === 'null') {
      if (!isNullish(actual)) return false
      continue
    }
    if (Array.isArray(expected)) {
      if (!expected.some((value) => sameValue(value, actual))) return false
      continue
    }
    if (!sameValue(expected, actual)) return false
  }
  return true
}
