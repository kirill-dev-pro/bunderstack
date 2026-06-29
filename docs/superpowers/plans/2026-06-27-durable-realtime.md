# Durable Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bunderstack's realtime SSE reliable — no silently-dropped events across reconnects, backgrounded tabs, or restarts.

**Architecture:** The server stamps each broadcast with a monotonic `eventId` and keeps a bounded ring buffer of recent events. On (re)connect the client re-subscribes with `since: lastEventId`; the broker replays buffered events it missed and reports a `gap` flag when replay can't cover the window, which makes the client do a full-refetch catch-up. The client transport moves from native `EventSource` to a `fetch` + `ReadableStream` reader so we own reconnect, a heartbeat watchdog, and `visibilitychange`-driven reconnect. A pluggable Redis broker adds cross-instance fan-out + persistence; without it an in-memory broker is used.

**Tech Stack:** Bun, `bun:test`, Hono, `@tanstack/query-core`, `Bun.RedisClient`, TypeScript.

## Global Constraints

- Runtime/test: Bun only — `bun test`, `bun <file>`. Never node/jest/vitest.
- Redis: use `Bun.RedisClient` / `Bun.redis`. Never `ioredis` or `redis`.
- Back-compat: `realtime: true` config must keep working; `createRealtimeBroker` must remain a working export (aliased).
- The realtime client package (`bunderstack-query`) must stay framework-agnostic — depend only on `@tanstack/query-core`, never React/Solid.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Frequent commits.
- Event payload shape on the wire is `{ eventId, action, table, record }`; the connect frame stays `{ clientId }`; keepalive stays `: ping`.
- Access/scope filtering for replayed events must reuse the existing `checkAccessSync` + scope logic in `publish` — do not duplicate access rules.

---

### Task 1: Memory broker — event IDs + ring buffer

**Files:**

- Modify: `packages/bunderstack/src/realtime.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Test: `packages/bunderstack/src/realtime.test.ts` (extend)

**Interfaces:**

- Consumes: existing `createRealtimeBroker({ access })`, `RealtimeBroker`, `validateAndResolveAccess`.
- Produces:
  - `createRealtimeBroker(opts: { access: ResolvedAccess; bufferSize?: number })` now stamps events and buffers them.
  - `createMemoryRealtimeBroker` exported as an alias of `createRealtimeBroker`.
  - Wire payload from `publish` becomes `{ eventId: number, action, table, record }` with `eventId` starting at 1 and incrementing by 1 per published (and buffered) event.
  - Internal `BufferedEvent = { eventId: number; table: string; action: RealtimeAction; record: Record<string, unknown> }`.
  - Config: `realtime` object option gains `bufferSize?: number` (default 1000).

- [ ] **Step 1: Write failing tests for event IDs + eviction**

Add to `packages/bunderstack/src/realtime.test.ts`:

```ts
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
    const res = broker.setContext(a.id, {
      user: { id: 'u_1', email: 'a@b.c' },
      activeOrganizationId: 'org_1',
      subscriptions: new Set(['boards']),
      since: 0,
    })
    expect(res.gap).toBe(true)
    expect(a.received.map((e: any) => e.eventId)).toEqual([2, 3])
  })
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd packages/bunderstack && bun test src/realtime.test.ts`
Expected: FAIL — payload has no `eventId`; `setContext` returns `void` (no `.gap`); `bufferSize` ignored.

- [ ] **Step 3: Implement event ids + ring buffer in `realtime.ts`**

In `createRealtimeBroker`, add buffer state and stamping. Replace the broker body so it reads:

```ts
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
```

Add the buffered-event type near the top (after `Subscriber`):

```ts
type BufferedEvent = {
  eventId: number
  table: string
  action: RealtimeAction
  record: Record<string, unknown>
}
```

Update the `RealtimeBroker` type's `setContext` signature:

```ts
  setContext(
    id: string,
    ctx: {
      user: AccessUser | null
      activeOrganizationId: string | null
      subscriptions: Set<string>
      since?: number | null
    },
  ): { gap: boolean }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd packages/bunderstack && bun test src/realtime.test.ts`
Expected: PASS (all old + new cases).

- [ ] **Step 5: Add `bufferSize` to config schema**

In `packages/bunderstack/src/config.ts`, change the `realtime` schema entry (currently `z.object({ keepaliveMs: z.number().optional() })`) to:

```ts
  realtime: z
    .union([
      z.boolean(),
      z.object({
        keepaliveMs: z.number().optional(),
        bufferSize: z.number().optional(),
      }),
    ])
    .optional(),
```

And update both the `BunderstackConfig.realtime` and `ResolvedConfig.realtime` TypeScript types in the same file from `boolean | { keepaliveMs?: number }` to:

```ts
  realtime?: boolean | { keepaliveMs?: number; bufferSize?: number }
```

- [ ] **Step 6: Wire `bufferSize` through `createBunderstack`**

In `packages/bunderstack/src/index.ts`, where the broker is created (`createRealtimeBroker({ access: resolvedAccess })`), pass the buffer size:

```ts
const broker = config.realtime
  ? createRealtimeBroker({
      access: resolvedAccess,
      bufferSize:
        typeof config.realtime === 'object'
          ? config.realtime.bufferSize
          : undefined,
    })
  : undefined
```

- [ ] **Step 7: Run the full bunderstack suite, commit**

Run: `cd packages/bunderstack && bun test`
Expected: PASS.

```bash
git add packages/bunderstack/src/realtime.ts packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/realtime.test.ts
git commit -m "feat(realtime): monotonic event ids + bounded replay buffer in broker"
```

---

### Task 2: Server — replay protocol over the SSE router (`since` + `gap`)

**Files:**

- Modify: `packages/bunderstack/src/realtime.ts` (the `buildRealtimeRouter` POST handler)
- Test: `packages/bunderstack/src/realtime-sse.test.ts` (modify + extend)

**Interfaces:**

- Consumes: `broker.setContext(..., { since })` returning `{ gap }` (Task 1).
- Produces:
  - `POST /realtime` accepts body `{ clientId: string; subscriptions: string[]; since?: number | null }`.
  - `POST /realtime` responds `200` with JSON `{ gap: boolean }` (was `204` empty).
  - On reconnect with `since`, the stream replays missed, access-filtered events for the subscriber.

- [ ] **Step 1: Update the existing POST test (204 -> 200 + gap) and add a replay test**

In `packages/bunderstack/src/realtime-sse.test.ts`, change the existing assertion `expect(sub.status).toBe(204)` to:

```ts
expect(sub.status).toBe(200)
expect(await sub.json()).toEqual({ gap: false })
```

Then add a new test:

```ts
it('replays missed events on reconnect when since is provided', async () => {
  const broker = createRealtimeBroker({ access })
  const router = buildRealtimeRouter(broker, { auth: auth as never })

  // First connection subscribes and receives event #1.
  const res1 = await router.fetch(new Request('http://x/realtime'))
  const r1 = res1.body!.getReader()
  const first = new TextDecoder().decode((await r1.read()).value)
  const clientId1 = JSON.parse(first.replace(/^data: /, '').trim()).clientId
  await router.fetch(
    new Request('http://x/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId1, subscriptions: ['boards'] }),
    }),
  )
  broker.publish('boards', 'create', {
    id: 'b1',
    organizationId: 'org_1',
    title: 'X',
  })
  const ev1 = JSON.parse(
    new TextDecoder()
      .decode((await r1.read()).value)
      .replace(/^data: /, '')
      .trim(),
  )
  expect(ev1.eventId).toBe(1)
  await r1.cancel() // simulate disconnect

  // While disconnected, another event is published.
  broker.publish('boards', 'update', {
    id: 'b1',
    organizationId: 'org_1',
    title: 'Y',
  })

  // Reconnect: new clientId, POST with since=1 -> event #2 is replayed on the new stream.
  const res2 = await router.fetch(new Request('http://x/realtime'))
  const r2 = res2.body!.getReader()
  const connect2 = new TextDecoder().decode((await r2.read()).value)
  const clientId2 = JSON.parse(connect2.replace(/^data: /, '').trim()).clientId
  const sub2 = await router.fetch(
    new Request('http://x/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: clientId2,
        subscriptions: ['boards'],
        since: 1,
      }),
    }),
  )
  expect(await sub2.json()).toEqual({ gap: false })
  const replayed = JSON.parse(
    new TextDecoder()
      .decode((await r2.read()).value)
      .replace(/^data: /, '')
      .trim(),
  )
  expect(replayed).toEqual({
    eventId: 2,
    action: 'update',
    table: 'boards',
    record: { id: 'b1', organizationId: 'org_1', title: 'Y' },
  })
  await r2.cancel()
})
```

- [ ] **Step 2: Run the SSE tests, verify they fail**

Run: `cd packages/bunderstack && bun test src/realtime-sse.test.ts`
Expected: FAIL — POST still returns 204 with no body; no `since` handling.

- [ ] **Step 3: Update the POST handler in `buildRealtimeRouter`**

Replace the POST handler body in `packages/bunderstack/src/realtime.ts`:

```ts
router.post('/realtime', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    clientId?: string
    subscriptions?: string[]
    since?: number | null
  } | null
  if (!body?.clientId || !Array.isArray(body.subscriptions)) {
    return c.json({ error: 'clientId and subscriptions required' }, 400)
  }
  const { user, activeOrganizationId } = await resolveSession(
    opts.auth,
    c.req.raw.headers,
  )
  const { gap } = broker.setContext(body.clientId, {
    user,
    activeOrganizationId,
    subscriptions: new Set(body.subscriptions),
    since: body.since ?? null,
  })
  return c.json({ gap }, 200)
})
```

- [ ] **Step 4: Run the SSE tests, verify they pass**

Run: `cd packages/bunderstack && bun test src/realtime-sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full bunderstack suite, commit**

Run: `cd packages/bunderstack && bun test`
Expected: PASS.

```bash
git add packages/bunderstack/src/realtime.ts packages/bunderstack/src/realtime-sse.test.ts
git commit -m "feat(realtime): since-based replay + gap signal over SSE router"
```

---

### Task 3: Redis broker + broker selection

**Files:**

- Create: `packages/bunderstack/src/realtime-redis.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/realtime-redis.test.ts`

**Interfaces:**

- Consumes: `RealtimeBroker`, `ResolvedAccess`, the `deliverable`/filter behavior (same semantics as Task 1).
- Produces:
  - `createRedisRealtimeBroker(opts: { access: ResolvedAccess; redis: RedisLike; bufferSize?: number; channel?: string }): RealtimeBroker & { ready: Promise<void> }`
  - `type RedisLike` — the minimal injected client surface this broker needs:
    ```ts
    export type RedisLike = {
      incr(key: string): Promise<number>
      publish(channel: string, message: string): Promise<unknown>
      subscribe(
        channel: string,
        listener: (message: string) => void,
      ): Promise<unknown>
      // capped event log
      lpush(key: string, value: string): Promise<unknown>
      ltrim(key: string, start: number, stop: number): Promise<unknown>
      lrange(key: string, start: number, stop: number): Promise<string[]>
    }
    ```
  - Config `realtime.redis?: string | { url: string; token?: string }`; falls back to `process.env.REDIS_URL`.
  - `createBunderstack` selects the Redis broker when a redis URL is resolved, else the memory broker.

> **Note on Bun.redis:** `RedisLike` is intentionally a narrow injected interface so the broker logic is testable with a fake. When wiring the real client in `index.ts`, construct `new Bun.RedisClient(url)` and verify each method name against the installed `bun-types` (`Bun.RedisClient`); adapt the adapter that maps `RedisLike` onto it if Bun's method names differ (e.g. list/stream command names). Do NOT use `ioredis`.

- [ ] **Step 1: Write failing tests with a fake redis**

Create `packages/bunderstack/src/realtime-redis.test.ts`:

```ts
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
```

> Note: this test treats `setContext` as possibly async. Implement `setContext` to return `{ gap } | Promise<{ gap }>`; the test `await`s it (awaiting a plain value is fine). Keep `register`/`unregister` synchronous to match the `RealtimeBroker` interface; `publish` may be async on the redis broker (the test `await`s it).

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/bunderstack && bun test src/realtime-redis.test.ts`
Expected: FAIL — `realtime-redis.ts` does not exist.

- [ ] **Step 3: Implement the Redis broker**

Create `packages/bunderstack/src/realtime-redis.ts`:

```ts
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
  const ready = opts.redis
    .subscribe(channel, (message) => {
      try {
        fanOut(JSON.parse(message) as WireEvent)
      } catch {
        /* ignore malformed */
      }
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
      const raw = await opts.redis.lrange(logKey, 0, bufferSize - 1)
      const events = raw
        .map((r) => JSON.parse(r) as WireEvent)
        .filter((e) => e.eventId > since)
        .sort((a, b) => a.eventId - b.eventId)

      const oldestInLog = raw.length
        ? (JSON.parse(raw[raw.length - 1]!) as WireEvent).eventId
        : since + 1
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
```

> If TypeScript complains that `setContext`/`publish` returning Promises don't match the `RealtimeBroker` interface from Task 1, widen the interface in `realtime.ts`: `setContext(...): { gap: boolean } | Promise<{ gap: boolean }>` and `publish(...): void | Promise<void>`. The router already `await`s nothing on `publish` from crud; verify `crud.ts` calls `broker.publish(...)` without needing the result (it does) — if it must await, leave as-is since fire-and-forget is acceptable for broadcast. Also export `RealtimeAction` from `realtime.ts` (it already is).

- [ ] **Step 4: Run the redis test, verify it passes**

Run: `cd packages/bunderstack && bun test src/realtime-redis.test.ts`
Expected: PASS.

- [ ] **Step 5: Add redis to config schema + resolution**

In `packages/bunderstack/src/config.ts`:

Extend the realtime object schema (from Task 1 Step 5) to include `redis`:

```ts
  realtime: z
    .union([
      z.boolean(),
      z.object({
        keepaliveMs: z.number().optional(),
        bufferSize: z.number().optional(),
        redis: z
          .union([z.string(), z.object({ url: z.string(), token: z.string().optional() })])
          .optional(),
      }),
    ])
    .optional(),
```

Update the TS types (`BunderstackConfig.realtime` and `ResolvedConfig.realtime`):

```ts
  realtime?:
    | boolean
    | {
        keepaliveMs?: number
        bufferSize?: number
        redis?: string | { url: string; token?: string }
      }
```

Add a helper in `config.ts` to resolve a redis URL (used by index.ts):

```ts
export function resolveRealtimeRedisUrl(
  realtime: ResolvedConfig['realtime'],
): string | undefined {
  const fromConfig =
    typeof realtime === 'object' && realtime.redis
      ? typeof realtime.redis === 'string'
        ? realtime.redis
        : realtime.redis.url
      : undefined
  return fromConfig ?? process.env.REDIS_URL ?? undefined
}
```

- [ ] **Step 6: Select the broker in `createBunderstack`**

In `packages/bunderstack/src/index.ts`, update imports and broker creation:

```ts
import { createRealtimeBroker, buildRealtimeRouter } from './realtime.ts'
import { createRedisRealtimeBroker } from './realtime-redis.ts'
import { resolveRealtimeRedisUrl } from './config.ts'
```

Replace the broker creation block:

```ts
const realtimeBufferSize =
  typeof config.realtime === 'object' ? config.realtime.bufferSize : undefined
const redisUrl = config.realtime
  ? resolveRealtimeRedisUrl(config.realtime)
  : undefined
const broker = config.realtime
  ? redisUrl
    ? createRedisRealtimeBroker({
        access: resolvedAccess,
        redis: new Bun.RedisClient(redisUrl) as never,
        bufferSize: realtimeBufferSize,
      })
    : createRealtimeBroker({
        access: resolvedAccess,
        bufferSize: realtimeBufferSize,
      })
  : undefined
```

> Verify `new Bun.RedisClient(url)` exposes `incr/publish/subscribe/lpush/ltrim/lrange` against the installed `bun-types`. If a method name differs, write a tiny adapter object literal mapping `RedisLike` onto the real client instead of the `as never` cast, and drop the cast. Keep the import-free `Bun` global (no import needed in Bun).

- [ ] **Step 7: Run the full bunderstack suite, commit**

Run: `cd packages/bunderstack && bun test`
Expected: PASS.

```bash
git add packages/bunderstack/src/realtime-redis.ts packages/bunderstack/src/realtime-redis.test.ts packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts
git commit -m "feat(realtime): optional redis broker with cross-instance fan-out + replay log"
```

---

### Task 4: Client — custom fetch/ReadableStream SSE reader

**Files:**

- Modify: `packages/bunderstack-query/src/realtime-client.ts` (rewrite transport)
- Test: `packages/bunderstack-query/src/realtime-client.test.ts` (rewrite for fetch transport)

**Interfaces:**

- Consumes: server wire events `{ eventId, action, table, record }`, connect `{ clientId }`, POST `{ clientId, subscriptions, since }` -> `{ gap }`.
- Produces:
  - `createRealtimeClient(config: RealtimeClientConfig)` where `RealtimeClientConfig` drops `EventSourceImpl` and adds:
    ```ts
    export type RealtimeClientConfig = {
      baseUrl: string
      queryClient: QueryClient
      tables: string[]
      fetch?: typeof fetch
      keepaliveMs?: number
      onStatus?: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void
    }
    ```
  - Returns `{ subscribe(topics: string[]): Promise<void>; close(): void }` (same shape as today).
  - Tracks `lastEventId`, re-subscribes with `since` on every (re)connect, and `invalidateQueries` all subscribed tables' lists when the POST reports `gap: true`.

- [ ] **Step 1: Write failing tests for the fetch transport**

Rewrite `packages/bunderstack-query/src/realtime-client.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/query-core'
import { createRealtimeClient } from './realtime-client.ts'

// A controllable SSE response: push frames, then optionally end the stream.
function makeStreamResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (obj: unknown) =>
      controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)),
    ping: () => controller.enqueue(enc.encode(`: ping\n\n`)),
    end: () => controller.close(),
  }
}

it('applies a create event: sets detail cache and invalidates the list', async () => {
  const qc = new QueryClient()
  const stream = makeStreamResponse()
  const posted: any[] = []
  const fetchMock = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ gap: false }), { status: 200 })
    }
    return stream.response // GET /realtime
  }) as unknown as typeof fetch

  const rt = createRealtimeClient({
    baseUrl: 'http://x/api',
    queryClient: qc,
    tables: ['cards'],
    fetch: fetchMock,
  })
  stream.push({ clientId: 'c1' })
  await rt.subscribe(['cards'])
  stream.push({
    eventId: 1,
    action: 'create',
    table: 'cards',
    record: { id: 'card_1', title: 'A' },
  })
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 5))

  expect(qc.getQueryData(['cards', 'detail', 'card_1'])).toEqual({
    id: 'card_1',
    title: 'A',
  })
  expect(posted[0]).toEqual({
    clientId: 'c1',
    subscriptions: ['cards'],
    since: null,
  })
  rt.close()
})

it('re-subscribes with since=lastEventId and invalidates all on gap after reconnect', async () => {
  const qc = new QueryClient()
  let invalidated: any[] = []
  qc.invalidateQueries = (async (filters: any) => {
    invalidated.push(filters?.queryKey)
  }) as any

  let stream = makeStreamResponse()
  const posted: any[] = []
  const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ gap: posted.length > 1 }), {
        status: 200,
      })
    }
    return stream.response
  }) as unknown as typeof fetch

  const rt = createRealtimeClient({
    baseUrl: 'http://x/api',
    queryClient: qc,
    tables: ['cards'],
    fetch: fetchMock,
  })
  stream.push({ clientId: 'c1' })
  await rt.subscribe(['cards'])
  stream.push({
    eventId: 7,
    action: 'update',
    table: 'cards',
    record: { id: 'card_1', title: 'B' },
  })
  await new Promise((r) => setTimeout(r, 5))

  // Simulate disconnect: end the stream, swap in a fresh one for the reconnect GET.
  invalidated = []
  const next = makeStreamResponse()
  const prev = stream
  stream = next
  prev.end()
  await new Promise((r) => setTimeout(r, 20)) // allow reconnect + new GET
  next.push({ clientId: 'c2' })
  await new Promise((r) => setTimeout(r, 10))

  const lastPost = posted[posted.length - 1]
  expect(lastPost).toEqual({
    clientId: 'c2',
    subscriptions: ['cards'],
    since: 7,
  })
  // gap:true on reconnect -> list invalidation happened
  expect(
    invalidated.some(
      (k) => Array.isArray(k) && k[0] === 'cards' && k[1] === 'list',
    ),
  ).toBe(true)
  rt.close()
})
```

- [ ] **Step 2: Run the client tests, verify they fail**

Run: `cd packages/bunderstack-query && bun test src/realtime-client.test.ts`
Expected: FAIL — current client uses `EventSource`, has no fetch-stream reader/reconnect.

- [ ] **Step 3: Rewrite `realtime-client.ts` with the fetch reader**

Replace `packages/bunderstack-query/src/realtime-client.ts`:

```ts
import type { QueryClient } from '@tanstack/query-core'

import { createTableClient } from './table-client.ts'

// ---------------------------------------------------------------------------
// Transport choice: custom fetch + ReadableStream SSE reader (NOT EventSource).
//
// Why not native EventSource?
//  - Its reconnect is opaque and browser-throttled. Backgrounded/throttled tabs
//    are exactly where it stalls — the failure we are fixing (tab stops updating
//    until you interact with it).
//  - We cannot run our own heartbeat watchdog, backoff, or force a reconnect on
//    `visibilitychange` with EventSource.
//
// Why the custom reader?
//  - We own reconnect (explicit backoff), a heartbeat watchdog (no bytes within
//    ~1.5x keepalive => tear down + reconnect), and visibility-driven reconnect.
//
// Cost / when to reconsider: more code than `new EventSource(url)`, and we must
// parse SSE frames ourselves. If real-world testing shows native EventSource is
// adequate, the previous implementation was: `new EventSource(`${root}/realtime`,
// { withCredentials: true })` with `es.onmessage` doing the same `apply()` and a
// `postSubscribe` on the connect frame. Swap the connect loop below back to that.
// ---------------------------------------------------------------------------

type RealtimeEvent = {
  eventId: number
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type RealtimeClientConfig = {
  baseUrl: string
  queryClient: QueryClient
  tables: string[]
  fetch?: typeof fetch
  keepaliveMs?: number
  onStatus?: (s: RealtimeStatus) => void
}

export function createRealtimeClient(config: RealtimeClientConfig) {
  const { baseUrl, queryClient, tables } = config
  const fetchFn = config.fetch ?? fetch
  const keepaliveMs = config.keepaliveMs ?? 30000
  const root = baseUrl.replace(/\/$/, '')

  const keysByTable = new Map(
    tables.map((t) => [
      t,
      createTableClient({ tableName: t, baseUrl: root, fetch: fetchFn }).keys,
    ]),
  )

  let clientId: string | null = null
  let lastTopics: string[] = []
  let lastEventId: number | null = null
  let closed = false
  let abort: AbortController | null = null
  let backoff = 1000
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function setStatus(s: RealtimeStatus) {
    config.onStatus?.(s)
  }

  function apply(evt: RealtimeEvent) {
    const keys = keysByTable.get(evt.table)
    if (!keys) return
    if (typeof evt.eventId === 'number') lastEventId = evt.eventId
    const id = evt.record['id'] as string | number
    if (evt.action === 'delete')
      queryClient.removeQueries({ queryKey: keys.detail(id) })
    else queryClient.setQueryData(keys.detail(id), evt.record)
    queryClient.invalidateQueries({ queryKey: keys.lists() })
  }

  function invalidateAllSubscribed() {
    for (const t of tables) {
      const keys = keysByTable.get(t)
      if (keys) queryClient.invalidateQueries({ queryKey: keys.lists() })
    }
  }

  async function postSubscribe(topics: string[]) {
    if (!clientId) return
    const res = await fetchFn(`${root}/realtime`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        subscriptions: topics,
        since: lastEventId,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as { gap?: boolean }
    if (body.gap) invalidateAllSubscribed()
  }

  function armWatchdog() {
    if (watchdog) clearTimeout(watchdog)
    // No bytes (event or `: ping`) within 1.5x keepalive => assume dead, reconnect.
    watchdog = setTimeout(
      () => {
        abort?.abort()
      },
      Math.round(keepaliveMs * 1.5),
    )
  }

  function handleFrame(frame: string) {
    armWatchdog()
    // Comment lines (": ping") are liveness only.
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'))
    if (!dataLines.length) return
    const json = dataLines.map((l) => l.slice(5).trim()).join('\n')
    let data: unknown
    try {
      data = JSON.parse(json)
    } catch {
      return
    }
    if (
      data &&
      typeof data === 'object' &&
      'clientId' in data &&
      (data as any).clientId
    ) {
      clientId = (data as any).clientId
      if (lastTopics.length) void postSubscribe(lastTopics)
      return
    }
    apply(data as RealtimeEvent)
  }

  async function connectLoop() {
    while (!closed) {
      abort = new AbortController()
      setStatus(clientId ? 'reconnecting' : 'connecting')
      try {
        const res = await fetchFn(`${root}/realtime`, {
          credentials: 'include',
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        })
        if (!res.body) throw new Error('no body')
        setStatus('open')
        backoff = 1000
        armWatchdog()
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            handleFrame(frame)
          }
        }
      } catch {
        /* fallthrough to reconnect */
      }
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      if (closed) break
      // Reconnect with jittered backoff (cap 30s). lastEventId drives replay.
      const wait = Math.min(backoff, 30000) * (0.5 + Math.random())
      backoff = Math.min(backoff * 2, 30000)
      await new Promise((r) => setTimeout(r, wait))
    }
    setStatus('closed')
  }

  // Refocus => force an immediate reconnect + catch-up (no waiting on backoff).
  const onVisible = () => {
    if (closed) return
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible'
    ) {
      backoff = 1000
      abort?.abort()
    }
  }
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', onVisible)

  void connectLoop()

  return {
    async subscribe(topics: string[]) {
      lastTopics = topics
      await postSubscribe(topics)
    },
    close() {
      closed = true
      if (watchdog) clearTimeout(watchdog)
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisible)
      abort?.abort()
      setStatus('closed')
    },
  }
}
```

- [ ] **Step 4: Run the client tests, verify they pass**

Run: `cd packages/bunderstack-query && bun test src/realtime-client.test.ts`
Expected: PASS.

> If timing-based assertions are flaky, increase the `setTimeout` waits in the test (not the implementation). Do not add real-time sleeps to the implementation.

- [ ] **Step 5: Run the full bunderstack-query suite, commit**

Run: `cd packages/bunderstack-query && bun test`
Expected: PASS.

```bash
git add packages/bunderstack-query/src/realtime-client.ts packages/bunderstack-query/src/realtime-client.test.ts
git commit -m "feat(query): durable realtime client — fetch reader, reconnect, watchdog, gap catch-up"
```

---

### Task 5: Verify the existing React Kanban example still wires up

**Files:**

- Read/verify: `examples/kanban-tanstack/src/lib/realtime.ts`, `examples/kanban-tanstack/src/api-client.ts`
- No code change expected (client API is back-compat); this task is the integration gate.

**Interfaces:**

- Consumes: `createRealtimeClient` (Task 4) — the example calls it with `{ baseUrl, queryClient, tables }`, all still valid.

- [ ] **Step 1: Typecheck the whole workspace**

Run: `bun run -F bunderstack typecheck 2>/dev/null || bunx tsc -p packages/bunderstack/tsconfig.json --noEmit; bunx tsc -p packages/bunderstack-query/tsconfig.json --noEmit`
Expected: no type errors in the two packages. (If the packages have a root `typecheck` script, prefer it: `bun run typecheck`.)

- [ ] **Step 2: Run the entire test suite from the repo root**

Run: `bun test`
Expected: PASS across `packages/bunderstack` and `packages/bunderstack-query`.

- [ ] **Step 3: Confirm the example compiles against the updated client**

Run: `cd examples/kanban-tanstack && bunx tsc --noEmit -p tsconfig.json`
Expected: no new type errors from `~/lib/realtime.ts` or `~/api-client.ts`. If `onStatus`/`keepaliveMs` are desired in the example, they are optional — no change required.

- [ ] **Step 4: Manual smoke test (documented, run by a human)**

Document in the PR description (no automated step): start the example, open two browser tabs, background one, mutate cards in the other, confirm the backgrounded tab reconciles within ~1.5x keepalive without manual interaction; also kill+restart the server and confirm tabs catch up via the gap-refetch path.

- [ ] **Step 5: Commit any doc/typecheck fixes (if needed)**

```bash
git add -A
git commit -m "chore(realtime): verify example wiring + workspace typecheck for durable realtime"
```

---

## Self-Review

**Spec coverage:**

- Broker as interface + memory/redis impls → Tasks 1, 3. ✅
- Event IDs + ring buffer → Task 1. ✅
- Replay protocol (`since` + `gap` in POST response, replay on stream) → Task 2. ✅
- Redis fan-out + INCR + capped log + `realtime.redis` config + selection → Task 3. ✅
- Custom fetch reader, reconnect/backoff, watchdog, visibilitychange, catch-up/gap invalidation, `lastEventId`, extensive comments → Task 4. ✅
- Config surface (`bufferSize`, `redis`, client `keepaliveMs`/`onStatus`) → Tasks 1, 3, 4. ✅
- Back-compat (`realtime: true`, `createRealtimeBroker` alias) → Tasks 1, 3. ✅
- Testing (server + client) → Tasks 1–4; integration gate Task 5. ✅
- Verification target (React Kanban testbed) → Task 5. ✅

**Placeholder scan:** No TBD/TODO; every code step has concrete code and exact run commands. Bun.redis method-name verification is an explicit, scoped instruction (not a placeholder) because it depends on the installed types. ✅

**Type consistency:** `RealtimeBroker.setContext` returns `{ gap: boolean }` (Task 1), widened to allow a Promise for the redis broker (Task 3); wire event shape `{ eventId, action, table, record }` used consistently in broker, router test, and client (`RealtimeEvent`); POST body `{ clientId, subscriptions, since }` and response `{ gap }` consistent across Tasks 2 and 4. `RedisLike` defined once (Task 3) and used in its test. ✅
