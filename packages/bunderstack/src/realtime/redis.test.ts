import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from '../access'
import { createRedisRealtimeBroker, type RedisLike } from './redis'

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
      scope: {
        read: (c) => ({
          organizationId: c.session?.activeOrganizationId ?? '',
        }),
        write: (c) => ({
          organizationId: c.session?.activeOrganizationId ?? '',
        }),
      },
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
  it('does not subscribe until realtime is explicitly started', async () => {
    const redis = makeFakeRedis()
    let subscriptions = 0
    const subscribe = redis.subscribe.bind(redis)
    redis.subscribe = async (channel, listener) => {
      subscriptions++
      return subscribe(channel, listener)
    }

    const broker = createRedisRealtimeBroker({ access, redis })
    expect(subscriptions).toBe(0)

    await broker.start()
    expect(subscriptions).toBe(1)
  })

  it('does not construct a Redis client until realtime starts', async () => {
    let created = 0
    const broker = createRedisRealtimeBroker({
      access,
      redis: () => {
        created++
        return makeFakeRedis()
      },
    })

    expect(created).toBe(0)
    await broker.start()
    expect(created).toBe(1)
  })

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
    await broker.start()
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
    await broker.start()
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
    await broker.start()
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
    await broker.start()
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

  it('fans out worker publications to subscribers on another broker instance', async () => {
    const redis = makeFakeRedis()
    const webBroker = createRedisRealtimeBroker({ access, redis })
    const workerBroker = createRedisRealtimeBroker({ access, redis })

    await webBroker.start()
    const browser = sub(webBroker, 'org_1', ['boards'])

    await workerBroker.publish('boards', 'update', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'Completed by worker',
    })

    expect(browser.received).toEqual([
      {
        eventId: 1,
        action: 'update',
        table: 'boards',
        record: {
          id: 'b1',
          organizationId: 'org_1',
          title: 'Completed by worker',
        },
      },
    ])

    await workerBroker.close()
    await webBroker.close()
  })

  it('isolates pub/sub messages, replay logs, and sequence counters when channel namespaces differ', async () => {
    const redis = makeFakeRedis()
    const brokerEnv1 = createRedisRealtimeBroker({
      access,
      redis,
      channel: 'bunderstack:env_1',
    })
    const brokerEnv2 = createRedisRealtimeBroker({
      access,
      redis,
      channel: 'bunderstack:env_2',
    })

    await brokerEnv1.start()
    await brokerEnv2.start()

    const sub1 = sub(brokerEnv1, 'org_1', ['boards'])
    const sub2 = sub(brokerEnv2, 'org_1', ['boards'])

    // Publish to env_1
    await brokerEnv1.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'Env 1 board',
    })

    // Publish to env_2
    await brokerEnv2.publish('boards', 'create', {
      id: 'b2',
      organizationId: 'org_1',
      title: 'Env 2 board',
    })

    // sub1 receives only env_1 message with eventId 1
    expect(sub1.received).toEqual([
      {
        eventId: 1,
        action: 'create',
        table: 'boards',
        record: { id: 'b1', organizationId: 'org_1', title: 'Env 1 board' },
      },
    ])

    // sub2 receives only env_2 message with eventId 1 (independent sequence counter)
    expect(sub2.received).toEqual([
      {
        eventId: 1,
        action: 'create',
        table: 'boards',
        record: { id: 'b2', organizationId: 'org_1', title: 'Env 2 board' },
      },
    ])

    // Replay log check for env_1
    const sub1Replay = sub(brokerEnv1, 'org_1', ['boards'])
    const res1 = await brokerEnv1.setContext(sub1Replay.id, {
      user: { id: 'u_1', email: 'a@b.c' },
      activeOrganizationId: 'org_1',
      subscriptions: new Set(['boards']),
      since: 0,
    })
    expect(res1.gap).toBe(false)
    expect(sub1Replay.received.map((e) => e.record['id'])).toEqual(['b1'])

    // Replay log check for env_2
    const sub2Replay = sub(brokerEnv2, 'org_1', ['boards'])
    const res2 = await brokerEnv2.setContext(sub2Replay.id, {
      user: { id: 'u_1', email: 'a@b.c' },
      activeOrganizationId: 'org_1',
      subscriptions: new Set(['boards']),
      since: 0,
    })
    expect(res2.gap).toBe(false)
    expect(sub2Replay.received.map((e) => e.record['id'])).toEqual(['b2'])

    await brokerEnv1.close()
    await brokerEnv2.close()
  })
})
