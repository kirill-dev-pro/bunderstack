// packages/bunderstack/src/realtime.ts
import { Hono } from 'hono'

import {
  checkAccessSync,
  resolveSession,
  rowMatchesScope,
  type AccessUser,
  type AuthSessionResolver,
  type ResolvedAccess,
  type ResolvedTableAccess,
} from '../access'

export type RealtimeAction = 'create' | 'update' | 'delete'

type Subscriber = {
  id: string
  send: (data: string) => void
  user: AccessUser | null
  activeOrganizationId: string | null
  subscriptions: Set<string>
}

type BufferedEvent = {
  eventId: number
  table: string
  action: RealtimeAction
  record: Record<string, unknown>
}

type RealtimeContextBody = {
  clientId: string
  subscriptions: string[]
  since?: number | null
}

export type RealtimeBroker = {
  start(): Promise<void>
  close(): Promise<void>
  register(send: (data: string) => void): { id: string }
  setContext(
    id: string,
    ctx: {
      user: AccessUser | null
      activeOrganizationId: string | null
      subscriptions: Set<string>
      since?: number | null
    },
  ): { gap: boolean } | Promise<{ gap: boolean }>
  unregister(id: string): void
  publish(
    table: string,
    action: RealtimeAction,
    record: Record<string, unknown>,
  ): void | Promise<void>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRealtimeContextBody(value: unknown): value is RealtimeContextBody {
  if (!isRecord(value)) return false
  return (
    typeof value.clientId === 'string' &&
    Array.isArray(value.subscriptions) &&
    value.subscriptions.every((item) => typeof item === 'string') &&
    (value.since === undefined ||
      value.since === null ||
      typeof value.since === 'number')
  )
}

function scopeOk(
  entry: ResolvedTableAccess,
  ctx: Parameters<typeof checkAccessSync>[1],
  record: Record<string, unknown>,
): boolean {
  if (!entry.readScope) return true
  return rowMatchesScope(record, entry.readScope(ctx))
}

export function buildRealtimeRouter(
  broker: RealtimeBroker,
  opts: { auth?: AuthSessionResolver; keepaliveMs?: number },
): Hono {
  const router = new Hono()
  const keepaliveMs = opts.keepaliveMs ?? 30000

  router.get('/realtime', () => {
    const encoder = new TextEncoder()
    let handle: { id: string }
    let keepalive: ReturnType<typeof setInterval>

    const stream = new ReadableStream({
      async start(controller) {
        await broker.start()
        const send = (data: string) =>
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        handle = broker.register(send)
        send(JSON.stringify({ clientId: handle.id }))
        keepalive = setInterval(
          () => controller.enqueue(encoder.encode(': ping\n\n')),
          keepaliveMs,
        )
      },
      cancel() {
        clearInterval(keepalive)
        broker.unregister(handle.id)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  router.post('/realtime', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isRealtimeContextBody(body)) {
      return c.json({ error: 'clientId and subscriptions required' }, 400)
    }
    const { user, activeOrganizationId } = await resolveSession(
      opts.auth,
      c.req.raw.headers,
    )
    const { gap } = await broker.setContext(body.clientId, {
      user,
      activeOrganizationId,
      subscriptions: new Set(body.subscriptions),
      since: body.since ?? null,
    })
    return c.json({ gap }, 200)
  })

  return router
}

export function createRealtimeBroker(opts: {
  access: ResolvedAccess
  bufferSize?: number
}): RealtimeBroker {
  const subscribers = new Map<string, Subscriber>()
  const bufferSize = opts.bufferSize ?? 1000
  const buffer: BufferedEvent[] = []
  let nextId = 1

  // Returns true when this subscriber should receive this record (topic + access + scope).
  function deliverable(
    s: Subscriber,
    table: string,
    record: Record<string, unknown>,
    id: unknown,
  ): boolean {
    const entry = tableEntry(opts.access, table)
    if (!entry) return false
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
    if (typeof entry.get === 'function') return false // function get-rules unsupported on realtime v1
    if (!checkAccessSync(entry.get, ctx, entry.ownerColumn).allowed)
      return false
    if (!scopeOk(entry, ctx, record)) return false
    return true
  }

  return {
    async start() {},
    async close() {},
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
      if (!s) return { gap: false }
      s.user = ctx.user
      s.activeOrganizationId = ctx.activeOrganizationId
      s.subscriptions = ctx.subscriptions

      const since = ctx.since ?? null
      if (since == null) return { gap: false } // fresh client; current data already loaded by queries

      const maxId = nextId - 1
      // since ahead of anything we issued => server restarted / different epoch => full catch-up.
      if (since > maxId) return { gap: true }
      const oldest = buffer.length ? buffer[0]!.eventId : nextId
      const gap = since < oldest - 1 // events between since and oldest were evicted
      for (const e of buffer) {
        if (e.eventId <= since) continue
        if (!deliverable(s, e.table, e.record, e.record['id'])) continue
        s.send(
          JSON.stringify({
            eventId: e.eventId,
            action: e.action,
            table: e.table,
            record: e.record,
          }),
        )
      }
      return { gap }
    },
    unregister(id) {
      subscribers.delete(id)
    },
    publish(table, action, record) {
      const entry = tableEntry(opts.access, table)
      if (!entry) return
      const eventId = nextId++
      buffer.push({ eventId, table, action, record })
      if (buffer.length > bufferSize) buffer.shift()
      const id = record['id']
      const payload = JSON.stringify({ eventId, action, table, record })
      for (const s of subscribers.values()) {
        if (!deliverable(s, table, record, id)) continue
        s.send(payload)
      }
    },
  }
}

export const createMemoryRealtimeBroker = createRealtimeBroker
