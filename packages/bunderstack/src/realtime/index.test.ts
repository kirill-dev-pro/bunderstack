// packages/bunderstack/src/realtime.test.ts
import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from '../access'
import { createRealtimeBroker } from './index'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }
const access = validateAndResolveAccess(schema, {
  boards: {
    list: 'authenticated',
    get: 'authenticated',
    create: 'authenticated',
    update: 'authenticated',
    delete: 'authenticated',
    scope: {
      read: (ctx) => ({
        organizationId: ctx.session?.activeOrganizationId ?? '',
      }),
      write: (ctx) => ({
        organizationId: ctx.session?.activeOrganizationId ?? '',
      }),
    },
  },
})

function sub(
  broker: ReturnType<typeof createRealtimeBroker>,
  org: string,
  topics: string[],
) {
  const received: unknown[] = []
  const s = broker.register((data) => received.push(JSON.parse(data)))
  broker.setContext(s.id, {
    user: { id: 'u_1', email: 'a@b.c' },
    activeOrganizationId: org,
    subscriptions: new Set(topics),
  })
  return { id: s.id, received }
}

describe('realtime broker', () => {
  it('delivers an event to a subscriber in the same org subscribed to the table', () => {
    const broker = createRealtimeBroker({ access })
    const a = sub(broker, 'org_1', ['boards'])
    broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'X',
    })
    expect(a.received).toEqual([
      {
        eventId: 1,
        action: 'create',
        table: 'boards',
        record: { id: 'b1', organizationId: 'org_1', title: 'X' },
      },
    ])
  })
  it('does NOT deliver cross-org events (scope)', () => {
    const broker = createRealtimeBroker({ access })
    const a = sub(broker, 'org_1', ['boards'])
    broker.publish('boards', 'create', {
      id: 'b2',
      organizationId: 'org_2',
      title: 'Y',
    })
    expect(a.received).toEqual([])
  })
  it('does NOT deliver to a subscriber not subscribed to the topic', () => {
    const broker = createRealtimeBroker({ access })
    const a = sub(broker, 'org_1', ['lists'])
    broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'X',
    })
    expect(a.received).toEqual([])
  })
  it('delivers on a record-id topic', () => {
    const broker = createRealtimeBroker({ access })
    const a = sub(broker, 'org_1', ['boards/b1'])
    broker.publish('boards', 'update', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'Z',
    })
    expect(a.received.length).toBe(1)
  })
  it('stops delivering after unregister', () => {
    const broker = createRealtimeBroker({ access })
    const a = sub(broker, 'org_1', ['boards'])
    broker.unregister(a.id)
    broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'X',
    })
    expect(a.received).toEqual([])
  })
})

describe('realtime broker — event ids + buffer', () => {
  it('stamps a monotonic eventId on each published payload', () => {
    const broker = createRealtimeBroker({ access })
    const a = sub(broker, 'org_1', ['boards'])
    broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'X',
    })
    broker.publish('boards', 'update', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'Y',
    })
    expect(a.received).toEqual([
      {
        eventId: 1,
        action: 'create',
        table: 'boards',
        record: { id: 'b1', organizationId: 'org_1', title: 'X' },
      },
      {
        eventId: 2,
        action: 'update',
        table: 'boards',
        record: { id: 'b1', organizationId: 'org_1', title: 'Y' },
      },
    ])
  })

  it('keeps only the last bufferSize events in the replay buffer', () => {
    const broker = createRealtimeBroker({ access, bufferSize: 2 })
    // No subscribers yet — events go to the buffer only.
    broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: '1',
    })
    broker.publish('boards', 'create', {
      id: 'b2',
      organizationId: 'org_1',
      title: '2',
    })
    broker.publish('boards', 'create', {
      id: 'b3',
      organizationId: 'org_1',
      title: '3',
    })
    // Reconnect from before everything: since=0 -> replay should only have the last 2 (ids 2,3) and report gap.
    const a = sub(broker, 'org_1', ['boards'])
    // Memory broker setContext is synchronous; cast away the union to avoid TS2339.
    const res = broker.setContext(a.id, {
      user: { id: 'u_1', email: 'a@b.c' },
      activeOrganizationId: 'org_1',
      subscriptions: new Set(['boards']),
      since: 0,
    }) as { gap: boolean }
    expect(res.gap).toBe(true)
    expect(a.received.map((e: any) => e.eventId)).toEqual([2, 3])
  })
})
