/**
 * The wire frames of a live view (`GET /api/{table}:live`).
 *
 * A live view is one SSE stream that opens with a snapshot of a list query and
 * then delivers only what that view cares about. The server decides membership
 * and placement, so a client applies frames without knowing the filter or sort
 * rules, and a reconnect replays a fresh snapshot instead of a refetch.
 *
 * Types only: both the browser client and the server import this module.
 */

export type LiveSnapshotFrame<TRow = Record<string, unknown>> = {
  type: 'snapshot'
  items: TRow[]
  operationId?: string
  /** The values the server resolved, not the values the caller sent. */
  sort: string
  order: 'asc' | 'desc'
  limit: number
  /** True when rows exist below the window. */
  hasMore: boolean
}

export type LiveUpsertFrame<TRow = Record<string, unknown>> = {
  type: 'upsert'
  record: TRow
  operationId?: string
  /** The id this row follows in the view; `null` means the head. */
  afterId: string | null
}

export type LiveRemoveFrame = {
  type: 'remove'
  id: string
  operationId?: string
}

export type LiveHeartbeatFrame = { type: 'heartbeat'; intervalMs: number }

export type LiveDeltaFrame<TRow = Record<string, unknown>> =
  | LiveUpsertFrame<TRow>
  | LiveRemoveFrame

export type LiveFrame<TRow = Record<string, unknown>> =
  | LiveSnapshotFrame<TRow>
  | LiveDeltaFrame<TRow>
  | LiveHeartbeatFrame

/** The query a live view accepts: the list contract a stream can honor. */
export type LiveInput = {
  limit?: number
  sort?: string
  order?: 'asc' | 'desc'
  filters?: Record<string, unknown>
}
