// packages/bunderstack/src/realtime.ts
import {
  checkAccessSync,
  rowMatchesScope,
  type AccessUser,
  type ResolvedAccess,
  type ResolvedTableAccess,
} from './access.ts'

export type RealtimeAction = 'create' | 'update' | 'delete'

type Subscriber = {
  id: string
  send: (data: string) => void
  user: AccessUser | null
  activeOrganizationId: string | null
  subscriptions: Set<string>
}

export type RealtimeBroker = {
  register(send: (data: string) => void): { id: string }
  setContext(
    id: string,
    ctx: {
      user: AccessUser | null
      activeOrganizationId: string | null
      subscriptions: Set<string>
    },
  ): void
  unregister(id: string): void
  publish(
    table: string,
    action: RealtimeAction,
    record: Record<string, unknown>,
  ): void
}

function tableEntry(
  access: ResolvedAccess,
  tableName: string,
): ResolvedTableAccess | undefined {
  for (const entry of access.values()) {
    if (entry.tableName === tableName) return entry
  }
  return undefined
}

function scopeOk(
  entry: ResolvedTableAccess,
  ctx: Parameters<typeof checkAccessSync>[1],
  record: Record<string, unknown>,
): boolean {
  if (!entry.scope) return true
  return rowMatchesScope(record, entry.scope(ctx))
}

export function createRealtimeBroker(opts: {
  access: ResolvedAccess
}): RealtimeBroker {
  const subscribers = new Map<string, Subscriber>()

  return {
    register(send) {
      const id = crypto.randomUUID()
      subscribers.set(id, {
        id,
        send,
        user: null,
        activeOrganizationId: null,
        subscriptions: new Set(),
      })
      return { id }
    },
    setContext(id, ctx) {
      const s = subscribers.get(id)
      if (!s) return
      s.user = ctx.user
      s.activeOrganizationId = ctx.activeOrganizationId
      s.subscriptions = ctx.subscriptions
    },
    unregister(id) {
      subscribers.delete(id)
    },
    publish(table, action, record) {
      const entry = tableEntry(opts.access, table)
      if (!entry) return
      const id = record['id']
      const payload = JSON.stringify({ action, table, record })

      for (const s of subscribers.values()) {
        const topicMatch =
          s.subscriptions.has(table) ||
          (id != null && s.subscriptions.has(`${table}/${String(id)}`))
        if (!topicMatch) continue

        const ctx = {
          user: s.user,
          request: new Request('http://realtime.local'),
          row: record,
          session: { activeOrganizationId: s.activeOrganizationId },
        }

        if (typeof entry.get === 'function') continue // function get-rules unsupported on realtime v1
        if (!checkAccessSync(entry.get, ctx, entry.ownerColumn).allowed) continue
        if (!scopeOk(entry, ctx, record)) continue
        s.send(payload)
      }
    },
  }
}
