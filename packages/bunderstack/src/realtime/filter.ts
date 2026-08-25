import { getEventMeta, withEventMeta } from '@orpc/server'

import type {
  AccessUser,
  OperationRule,
  ResolvedAccess,
  ResolvedTableAccess,
} from '../access'
import type { RealtimeChange } from './publisher'

import { checkAccess, rowMatchesScope, tableEntryForName } from '../access'

type GetSession = () => Promise<{
  user: AccessUser | null
  activeOrganizationId: string | null
}>

export interface FilterRealtimeChangesOptions {
  subscriptions: readonly string[]
  access: ResolvedAccess
  request: Request
  getSession: GetSession
}

export interface FilterTableChangesOptions {
  /** Events arrive under this name — the schema key they were published with. */
  tableName: string
  entry: ResolvedTableAccess
  /**
   * The operation right this stream reads under: `get` for a subscription to
   * rows, `list` for a live view of a query.
   */
  rule: OperationRule
  request: Request
  getSession: GetSession
}

/**
 * Whether one change may reach this subscriber: the given right plus the read
 * scope of the row, evaluated against the caller's session. The session
 * resolves at most once per stream.
 */
export function createChangeGuard(
  entry: ResolvedTableAccess,
  options: { rule: OperationRule; request: Request; getSession: GetSession },
): (change: RealtimeChange) => Promise<boolean> {
  let sessionPromise: ReturnType<GetSession> | undefined
  const getSession = () => (sessionPromise ??= options.getSession())

  return async (change) => {
    if (!entry.enabled || options.rule === 'deny') return false

    const needsSession =
      options.rule !== 'public' || entry.readScope !== undefined
    const session = needsSession
      ? await getSession()
      : { user: null, activeOrganizationId: null }
    const context = {
      request: options.request,
      user: session.user,
      row: change.record,
      session: { activeOrganizationId: session.activeOrganizationId },
    }
    if (
      !(await checkAccess(options.rule, context, entry.ownerColumn)).allowed
    ) {
      return false
    }
    if (
      entry.readScope &&
      !rowMatchesScope(change.record, entry.readScope(context))
    ) {
      return false
    }
    return true
  }
}

/** Preserve publisher event metadata (ids) across the projection. */
function project(change: RealtimeChange): RealtimeChange {
  const projected: RealtimeChange = {
    table: change.table,
    action: change.action,
    record: change.record,
    ...(change.operationId ? { operationId: change.operationId } : {}),
  }
  const meta = getEventMeta(change)
  return meta ? withEventMeta(projected, meta) : projected
}

export async function* filterRealtimeChanges(
  source: AsyncIterable<RealtimeChange>,
  options: FilterRealtimeChangesOptions,
): AsyncGenerator<RealtimeChange, void, void> {
  const subscriptions = new Set(options.subscriptions)
  // One guard — and therefore one cached session — per table entry.
  const guards = new Map<
    ResolvedTableAccess,
    ReturnType<typeof createChangeGuard>
  >()

  for await (const change of source) {
    // Events name tables by schema key; the SQL-name lookup stays as a fallback
    // for publishers outside the CRUD path that only know the physical name.
    const entry =
      options.access.get(change.table) ??
      tableEntryForName(options.access, change.table)
    if (!entry?.enabled) continue

    const recordId = change.record.id
    if (
      !subscriptions.has(change.table) &&
      (recordId == null ||
        !subscriptions.has(`${change.table}/${String(recordId)}`))
    ) {
      continue
    }

    let guard = guards.get(entry)
    if (!guard) {
      guard = createChangeGuard(entry, { ...options, rule: entry.get })
      guards.set(entry, guard)
    }
    if (!(await guard(change))) continue
    yield project(change)
  }
}

/**
 * The same stream narrowed to one table with its access entry known up front —
 * what a live view (`GET /{table}:live`) consumes.
 */
export async function* filterTableChanges(
  source: AsyncIterable<RealtimeChange>,
  options: FilterTableChangesOptions,
): AsyncGenerator<RealtimeChange, void, void> {
  const guard = createChangeGuard(options.entry, options)
  for await (const change of source) {
    if (change.table !== options.tableName) continue
    if (!(await guard(change))) continue
    yield project(change)
  }
}
