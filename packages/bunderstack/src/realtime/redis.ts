import type { RealtimeAction, RealtimeBroker } from './index'

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
} from '../access'

export type RedisLike = {
  incr(key: string): Promise<number>
  publish(channel: string, message: string): Promise<unknown>
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<unknown>
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

function tableEntry(
  access: ResolvedAccess,
  name: string,
): ResolvedTableAccess | undefined {
  for (const entry of access.values())
    if (entry.tableName === name) return entry
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRealtimeAction(value: unknown): value is RealtimeAction {
  return value === 'create' || value === 'update' || value === 'delete'
}

function parseWireEvent(raw: string): WireEvent | null {
  try {
    const value = JSON.parse(raw)
    if (
      !isRecord(value) ||
      typeof value.eventId !== 'number' ||
      typeof value.table !== 'string' ||
      !isRealtimeAction(value.action) ||
      !isRecord(value.record)
    ) {
      return null
    }
    return {
      eventId: value.eventId,
      table: value.table,
      action: value.action,
      record: value.record,
    }
  } catch {
    return null
  }
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

  function deliverable(
    s: Subscriber,
    table: string,
    record: Record<string, unknown>,
  ): boolean {
    const entry = tableEntry(opts.access, table)
    if (!entry) return false
    const id = record['id']
    const topicMatch =
      s.subscriptions.has(table) ||
      (id != null && s.subscriptions.has(`${table}/${String(id)}`))
    if (!topicMatch) return false
    const ctx = {
      user: s.user,
      request: new Request('http://realtime.local'),
      row: record,
      session: { activeOrganizationId: s.activeOrganizationId },
    }
    if (typeof entry.get === 'function') return false
    if (!checkAccessSync(entry.get, ctx, entry.ownerColumn).allowed)
      return false
    if (entry.readScope && !rowMatchesScope(record, entry.readScope(ctx))) return false
    return true
  }

  function fanOut(evt: WireEvent) {
    const payload = JSON.stringify(evt)
    for (const s of subscribers.values()) {
      if (deliverable(s, evt.table, evt.record)) s.send(payload)
    }
  }

  // Subscribe once; all local delivery happens here.
  const ready = opts.redis
    .subscribe(channel, (message) => {
      const evt = parseWireEvent(message)
      if (evt) fanOut(evt)
    })
    .then(() => undefined)

  return {
    ready,
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
    async setContext(id, ctx) {
      const s = subscribers.get(id)
      if (!s) return { gap: false }
      s.user = ctx.user
      s.activeOrganizationId = ctx.activeOrganizationId
      s.subscriptions = ctx.subscriptions

      const since = ctx.since ?? null
      if (since == null) return { gap: false }

      // Log is LPUSH-ed (newest first); read newest->oldest, filter id>since.
      // If redis is unavailable, return { gap: true } so the client falls back
      // to a full refetch rather than 500-ing the POST handler.
      let raw: string[]
      try {
        raw = await opts.redis.lrange(logKey, 0, bufferSize - 1)
      } catch {
        return { gap: true }
      }
      const events = raw
        .map(parseWireEvent)
        .filter((e) => e !== null)
        .filter((e) => e.eventId > since)
        .sort((a, b) => a.eventId - b.eventId)

      const oldestInLog = events.length ? events[0]!.eventId : since + 1
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
      try {
        const eventId = await opts.redis.incr(counterKey)
        const evt: WireEvent = { eventId, table, action, record }
        const msg = JSON.stringify(evt)
        await opts.redis.lpush(logKey, msg)
        await opts.redis.ltrim(logKey, 0, bufferSize - 1)
        await opts.redis.publish(channel, msg)
      } catch {
        // Broadcast is best-effort: a redis blip must not reject the floating
        // promise (callers use `void broker?.publish(...)` with no .catch).
        // Correctness self-heals: reconnecting clients use the since/gap replay
        // path which issues a full refetch when events were missed.
      }
    },
  }
}
