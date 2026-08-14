import { getEventMeta, withEventMeta } from '@orpc/server'

import type { AccessUser, ResolvedAccess } from '../access'
import type { RealtimeChange } from './publisher'

import { checkAccess, rowMatchesScope, tableEntryForName } from '../access'

export interface FilterRealtimeChangesOptions {
  subscriptions: readonly string[]
  access: ResolvedAccess
  request: Request
  getSession: () => Promise<{
    user: AccessUser | null
    activeOrganizationId: string | null
  }>
}

export async function* filterRealtimeChanges(
  source: AsyncIterable<RealtimeChange>,
  options: FilterRealtimeChangesOptions,
): AsyncGenerator<RealtimeChange, void, void> {
  const subscriptions = new Set(options.subscriptions)
  let sessionPromise:
    | ReturnType<FilterRealtimeChangesOptions['getSession']>
    | undefined
  const getSession = () => (sessionPromise ??= options.getSession())

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
    if (entry.get === 'deny') continue

    const needsSession = entry.get !== 'public' || entry.readScope !== undefined
    const session = needsSession
      ? await getSession()
      : { user: null, activeOrganizationId: null }
    const context = {
      request: options.request,
      user: session.user,
      row: change.record,
      session: { activeOrganizationId: session.activeOrganizationId },
    }
    if (!(await checkAccess(entry.get, context, entry.ownerColumn)).allowed) {
      continue
    }
    if (
      entry.readScope &&
      !rowMatchesScope(change.record, entry.readScope(context))
    ) {
      continue
    }

    const projected: RealtimeChange = {
      table: change.table,
      action: change.action,
      record: change.record,
    }
    const meta = getEventMeta(change)
    yield meta ? withEventMeta(projected, meta) : projected
  }
}
