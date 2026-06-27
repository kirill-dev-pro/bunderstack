// packages/bunderstack/src/realtime-redis.ts
//
// Redis-backed realtime broker: cross-instance fan-out + persistent replay log.
//
// Fan-out model: every instance SUBSCRIBEs one channel. publish() INCRs a global
// counter (monotonic eventId across instances/restarts), LPUSH+LTRIM a capped log
// for replay, then PUBLISHes. Redis delivers the message to ALL subscribers
// including the publisher, so local delivery happens uniformly inside the channel
// listener — never directly in publish() — to avoid double-delivery.
import {
  checkAccessSync,
  rowMatchesScope,
  type AccessUser,
  type ResolvedAccess,
  type ResolvedTableAccess,
} from './access.ts'
import type { RealtimeAction, RealtimeBroker } from './realtime.ts'

export type RedisLike = {
  incr(key: string): Promise<number>
  publish(channel: string, message: string): Promise<unknown>
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>
  lpush(key: string, value: string): Promise<unknown>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
}

type Subscriber = {
  id: string
  send: (data: string) => void
  user: AccessUser | null
  activeOrganizationId: string | null
  subscriptions: Set<string>
}

type WireEvent = {
  eventId: number
  table: string
  action: RealtimeAction
  record: Record<string, unknown>
}

function tableEntry(access: ResolvedAccess, name: string): ResolvedTableAccess | undefined {
  for (const entry of access.values()) if (entry.tableName === name) return entry
  return undefined
}

export function createRedisRealtimeBroker(opts: {
  access: ResolvedAccess
  redis: RedisLike
  bufferSize?: number
  channel?: string
}): RealtimeBroker & { ready: Promise<void> } {
  const subscribers = new Map<string, Subscriber>()
  const bufferSize = opts.bufferSize ?? 1000
  const channel = opts.channel ?? 'bunderstack:realtime'
  const logKey = `${channel}:log`
  const counterKey = `${channel}:seq`

  function deliverable(s: Subscriber, table: string, record: Record<string, unknown>): boolean {
    const entry = tableEntry(opts.access, table)
    if (!entry) return false
    const id = record['id']
    const topicMatch =
      s.subscriptions.has(table) || (id != null && s.subscriptions.has(`${table}/${String(id)}`))
    if (!topicMatch) return false
    const ctx = {
      user: s.user,
      request: new Request('http://realtime.local'),
      row: record,
      session: { activeOrganizationId: s.activeOrganizationId },
    }
    if (typeof entry.get === 'function') return false
    if (!checkAccessSync(entry.get, ctx, entry.ownerColumn).allowed) return false
    if (entry.scope && !rowMatchesScope(record, entry.scope(ctx))) return false
    return true
  }

  function fanOut(evt: WireEvent) {
    const payload = JSON.stringify(evt)
    for (const s of subscribers.values()) {
      if (deliverable(s, evt.table, evt.record)) s.send(payload)
    }
  }

  // Subscribe once; all local delivery happens here.
  const ready = opts.redis.subscribe(channel, (message) => {
    try {
      fanOut(JSON.parse(message) as WireEvent)
    } catch {
      /* ignore malformed */
    }
  }).then(() => undefined)

  return {
    ready,
    register(send) {
      const id = crypto.randomUUID()
      subscribers.set(id, { id, send, user: null, activeOrganizationId: null, subscriptions: new Set() })
      return { id }
    },
    async setContext(id, ctx) {
      const s = subscribers.get(id)
      if (!s) return { gap: false }
      s.user = ctx.user
      s.activeOrganizationId = ctx.activeOrganizationId
      s.subscriptions = ctx.subscriptions

      const since = ctx.since ?? null
      if (since == null) return { gap: false }

      // Log is LPUSH-ed (newest first); read newest->oldest, filter id>since.
      const raw = await opts.redis.lrange(logKey, 0, bufferSize - 1)
      const events = raw
        .map((r) => JSON.parse(r) as WireEvent)
        .filter((e) => e.eventId > since)
        .sort((a, b) => a.eventId - b.eventId)

      const oldestInLog = raw.length ? (JSON.parse(raw[raw.length - 1]!) as WireEvent).eventId : since + 1
      const gap = oldestInLog > since + 1
      for (const e of events) {
        if (deliverable(s, e.table, e.record)) s.send(JSON.stringify(e))
      }
      return { gap }
    },
    unregister(id) {
      subscribers.delete(id)
    },
    async publish(table, action, record) {
      if (!tableEntry(opts.access, table)) return
      const eventId = await opts.redis.incr(counterKey)
      const evt: WireEvent = { eventId, table, action, record }
      const msg = JSON.stringify(evt)
      await opts.redis.lpush(logKey, msg)
      await opts.redis.ltrim(logKey, 0, bufferSize - 1)
      await opts.redis.publish(channel, msg)
    },
  }
}
