import type { LiveDeltaFrame } from '../live/protocol'
import type { RealtimeChange } from '../realtime/publisher'

import { matchesLiveFilters } from './live-view'

/**
 * The server-side state of one live-view connection: which rows the client
 * holds, in view order, and whether rows exist below the window.
 *
 * The window is what lets the server place a row for the client (`afterId`)
 * instead of making the browser repeat `ORDER BY`. It is also what makes a
 * removal from a truncated view ask for a fresh snapshot instead of silently
 * shrinking the view.
 *
 * Ordering follows `buildOrderBy` in `../list-query`: the sort column first,
 * then `id`, both in the query's direction. Values are compared in the process
 * on raw column values. That is exact for numbers, dates, and booleans, and
 * matches the database for ordinary text. A collation that differs from
 * code-unit order, or a NULLS rule other than "nulls first", can place a row
 * inside the window differently from the database.
 */

export type LiveWindowOptions = {
  sort: string
  order: 'asc' | 'desc'
  limit: number
  filters?: Record<string, unknown>
}

export type LiveWindowResult =
  | { type: 'none' }
  | { type: 'frames'; frames: LiveDeltaFrame[] }
  | { type: 'resnapshot' }

export type LiveWindow = {
  /** Adopt a query result as the current view. */
  reset: (items: Record<string, unknown>[], hasMore: boolean) => void
  /** What this change means for this view. */
  apply: (change: RealtimeChange) => LiveWindowResult
}

type WindowRow = { id: string; key: unknown }

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) return aNull ? (bNull ? 0 : -1) : 1
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  }
  const left = String(a)
  const right = String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export function createLiveWindow(options: LiveWindowOptions): LiveWindow {
  const direction = options.order === 'desc' ? -1 : 1
  let rows: WindowRow[] = []
  let hasMore = false

  const compareRows = (a: WindowRow, b: WindowRow): number =>
    direction * (compareValues(a.key, b.key) || compareValues(a.id, b.id))

  const rowOf = (record: Record<string, unknown>): WindowRow => ({
    id: String(record.id),
    key: record[options.sort],
  })

  /** Where this row belongs among rows that are already in order. */
  const placeOf = (row: WindowRow): number => {
    const index = rows.findIndex((current) => compareRows(row, current) < 0)
    return index === -1 ? rows.length : index
  }

  return {
    reset(items, nextHasMore) {
      rows = items.map(rowOf)
      hasMore = nextHasMore
    },

    apply(change) {
      const id = String(change.record.id)
      const metadata = change.operationId
        ? { operationId: change.operationId }
        : {}
      const index = rows.findIndex((row) => row.id === id)
      const held = index !== -1

      // The row left the view: deleted, or no longer a match for the filters.
      if (
        change.action === 'delete' ||
        !matchesLiveFilters(change.record, options.filters)
      ) {
        if (!held) return { type: 'none' }
        rows.splice(index, 1)
        // A row from below the window must take the free place, and only the
        // database knows which one.
        if (hasMore) return { type: 'resnapshot' }
        return {
          type: 'frames',
          frames: [{ type: 'remove', id, ...metadata }],
        }
      }

      if (held) rows.splice(index, 1)
      const row = rowOf(change.record)
      const place = placeOf(row)

      if (place >= options.limit) {
        // It sorts below the window. If the client holds it, it moved out.
        if (!held) return { type: 'none' }
        hasMore = true
        return {
          type: 'frames',
          frames: [{ type: 'remove', id, ...metadata }],
        }
      }

      rows.splice(place, 0, row)
      const frames: LiveDeltaFrame[] = [
        {
          type: 'upsert',
          record: change.record,
          afterId: place === 0 ? null : rows[place - 1]!.id,
          ...metadata,
        },
      ]
      if (rows.length > options.limit) {
        const evicted = rows.pop()!
        hasMore = true
        frames.push({ type: 'remove', id: evicted.id, ...metadata })
      }
      return { type: 'frames', frames }
    },
  }
}
