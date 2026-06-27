// packages/bunderstack/src/realtime-sse.test.ts
import { describe, it, expect } from 'bun:test'
import { createRealtimeBroker, buildRealtimeRouter } from './realtime.ts'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { validateAndResolveAccess } from './access.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const access = validateAndResolveAccess({ boards }, {
  boards: { list: 'authenticated', get: 'authenticated', scope: (c) => ({ organizationId: c.session?.activeOrganizationId ?? '' }) },
})
const auth = { api: { getSession: async () => ({ user: { id: 'u_1', email: 'a@b.c' }, session: { activeOrganizationId: 'org_1' } }) } }

describe('realtime SSE router', () => {
  it('GET /realtime streams a connect event with a clientId', async () => {
    const broker = createRealtimeBroker({ access })
    const router = buildRealtimeRouter(broker, { auth: auth as never })
    const res = await router.fetch(new Request('http://x/realtime'))
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('"clientId"')
    await reader.cancel()
  })

  it('POST /realtime sets subscriptions and the client then receives a scoped event', async () => {
    const broker = createRealtimeBroker({ access })
    const router = buildRealtimeRouter(broker, { auth: auth as never })
    const res = await router.fetch(new Request('http://x/realtime'))
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const clientId = JSON.parse(first.replace(/^data: /, '').trim()).clientId

    const sub = await router.fetch(new Request('http://x/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, subscriptions: ['boards'] }),
    }))
    expect(sub.status).toBe(200)
    expect(await sub.json()).toEqual({ gap: false })

    broker.publish('boards', 'create', { id: 'b1', organizationId: 'org_1', title: 'X' })
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain('"action":"create"')
    await reader.cancel()
  })

  it('replays missed events on reconnect when since is provided', async () => {
    const broker = createRealtimeBroker({ access })
    const router = buildRealtimeRouter(broker, { auth: auth as never })

    // First connection subscribes and receives event #1.
    const res1 = await router.fetch(new Request('http://x/realtime'))
    const r1 = res1.body!.getReader()
    const first = new TextDecoder().decode((await r1.read()).value)
    const clientId1 = JSON.parse(first.replace(/^data: /, '').trim()).clientId
    await router.fetch(new Request('http://x/realtime', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId1, subscriptions: ['boards'] }),
    }))
    broker.publish('boards', 'create', { id: 'b1', organizationId: 'org_1', title: 'X' })
    const ev1 = JSON.parse(new TextDecoder().decode((await r1.read()).value).replace(/^data: /, '').trim())
    expect(ev1.eventId).toBe(1)
    await r1.cancel() // simulate disconnect

    // While disconnected, another event is published.
    broker.publish('boards', 'update', { id: 'b1', organizationId: 'org_1', title: 'Y' })

    // Reconnect: new clientId, POST with since=1 -> event #2 is replayed on the new stream.
    const res2 = await router.fetch(new Request('http://x/realtime'))
    const r2 = res2.body!.getReader()
    const connect2 = new TextDecoder().decode((await r2.read()).value)
    const clientId2 = JSON.parse(connect2.replace(/^data: /, '').trim()).clientId
    const sub2 = await router.fetch(new Request('http://x/realtime', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId2, subscriptions: ['boards'], since: 1 }),
    }))
    expect(await sub2.json()).toEqual({ gap: false })
    const replayed = JSON.parse(new TextDecoder().decode((await r2.read()).value).replace(/^data: /, '').trim())
    expect(replayed).toEqual({ eventId: 2, action: 'update', table: 'boards', record: { id: 'b1', organizationId: 'org_1', title: 'Y' } })
    await r2.cancel()
  })
})
