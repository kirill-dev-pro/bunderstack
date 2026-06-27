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
    expect(sub.status).toBe(204)

    broker.publish('boards', 'create', { id: 'b1', organizationId: 'org_1', title: 'X' })
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain('"action":"create"')
    await reader.cancel()
  })
})
