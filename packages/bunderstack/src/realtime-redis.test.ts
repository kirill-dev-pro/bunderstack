import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from './access.ts'
import { createRedisRealtimeBroker, type RedisLike } from './realtime-redis.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const access = validateAndResolveAccess(
  { boards },
  {
    boards: {
      list: 'authenticated',
      get: 'authenticated',
      create: 'authenticated',
      update: 'authenticated',
      delete: 'authenticated',
      scope: (c) => ({ organizationId: c.session?.activeOrganizationId ?? '' }),
    },
  },
)

// In-memory fake that models the subset of redis we use, with synchronous-ish delivery.
function makeFakeRedis() {
  const lists = new Map<string, string[]>()
  const counters = new Map<string, number>()
  const channels = new Map<string, ((m: string) => void)[]>()
  const r: RedisLike = {
    async incr(k) {
      const n = (counters.get(k) ?? 0) + 1
      counters.set(k, n)
      return n
    },
    async publish(ch, msg) {
      for (const l of channels.get(ch) ?? []) l(msg)
      return 1
    },
    async subscribe(ch, listener) {
      const arr = channels.get(ch) ?? []
      arr.push(listener)
      channels.set(ch, arr)
    },
    async lpush(k, v) {
      const a = lists.get(k) ?? []
      a.unshift(v)
      lists.set(k, a)
      return a.length
    },
    async ltrim(k, start, stop) {
      const a = lists.get(k) ?? []
      lists.set(k, a.slice(start, stop + 1))
    },
    async lrange(k, start, stop) {
      const a = lists.get(k) ?? []
      return a.slice(start, stop === -1 ? undefined : stop + 1)
    },
  }
  return r
}

function sub(
  broker: ReturnType<typeof createRedisRealtimeBroker>,
  org: string,
  topics: string[],
) {
  const received: any[] = []
  const s = broker.register((data) => received.push(JSON.parse(data)))
  broker.setContext(s.id, {
    user: { id: 'u_1', email: 'a@b.c' },
    activeOrganizationId: org,
    subscriptions: new Set(topics),
  })
  return { id: s.id, received }
}

describe('redis realtime broker', () => {
  it('publish() resolves (never rejects) when redis incr/lpush throws', async () => {
    // Regression guard for Fix A: a redis network blip must not produce an
    // unhandledRejection that can crash the process. The broker is called with
    // void broker?.publish(...) — a fire-and-forget that cannot attach .catch.
    const failingRedis: RedisLike = {
      async incr() {
        throw new Error('redis connection lost')
      },
      async publish() {
        return 1
      },
      async subscribe(_ch, _listener) {},
      async lpush() {
        return 1
      },
      async ltrim() {},
      async lrange() {
        return []
      },
    }
    const broker = createRedisRealtimeBroker({ access, redis: failingRedis })
    await broker.ready
    // Must resolve, not reject — even though incr() throws.
    await expect(
      broker.publish('boards', 'create', {
        id: 'b1',
        organizationId: 'org_1',
        title: 'X',
      }),
    ).resolves.toBeUndefined()
  })

  it('fans out a published event to a same-org subscriber with a monotonic eventId', async () => {
    const broker = createRedisRealtimeBroker({ access, redis: makeFakeRedis() })
    await broker.ready
    const a = sub(broker, 'org_1', ['boards'])
    await broker.publish('boards', 'create', {
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

  it('does NOT fan out cross-org events', async () => {
    const broker = createRedisRealtimeBroker({ access, redis: makeFakeRedis() })
    await broker.ready
    const a = sub(broker, 'org_1', ['boards'])
    await broker.publish('boards', 'create', {
      id: 'b2',
      organizationId: 'org_2',
      title: 'Y',
    })
    expect(a.received).toEqual([])
  })

  it('replays buffered events from the redis log on reconnect (since)', async () => {
    const redis = makeFakeRedis()
    const broker = createRedisRealtimeBroker({ access, redis, bufferSize: 10 })
    await broker.ready
    await broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: '1',
    })
    await broker.publish('boards', 'update', {
      id: 'b1',
      organizationId: 'org_1',
      title: '2',
    })
    const a = sub(broker, 'org_1', ['boards'])
    const res = await broker.setContext(a.id, {
      user: { id: 'u_1', email: 'a@b.c' },
      activeOrganizationId: 'org_1',
      subscriptions: new Set(['boards']),
      since: 1,
    })
    expect(res.gap).toBe(false)
    expect(a.received.map((e) => e.eventId)).toEqual([2])
  })
})
