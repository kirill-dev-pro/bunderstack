import type { LiveFrame } from './protocol'

/**
 * One frame folded into a view's rows.
 *
 * Pure and immutable: a changed view is a new array, an unchanged view is the
 * same array, and a row the frame did not touch keeps its identity. That is
 * what `useSyncExternalStore` and a keyed list need to skip the rows a frame
 * did not change.
 */
export function applyLiveFrame<TRow extends { id: string }>(
  rows: readonly TRow[],
  frame: LiveFrame<TRow>,
): readonly TRow[] {
  if (frame.type === 'snapshot') return frame.items
  if (frame.type === 'heartbeat') return rows

  if (frame.type === 'remove') {
    const next = rows.filter((row) => row.id !== frame.id)
    return next.length === rows.length ? rows : next
  }

  // An upsert can move a row, so the stale copy goes first.
  const next = rows.filter((row) => row.id !== frame.record.id)
  let place: number
  if (frame.afterId === null) {
    place = 0
  } else {
    const anchor = next.findIndex((row) => row.id === frame.afterId)
    // An anchor the view does not hold means the row belongs at the end.
    place = anchor === -1 ? next.length : anchor + 1
  }
  next.splice(place, 0, frame.record)
  return next
}
