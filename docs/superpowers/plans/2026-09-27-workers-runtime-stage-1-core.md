# Workers Runtime Stage 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bunderstack core independent of Bun-only APIs in the request path, the job path, and module load, and give it one injected `Platform` for the services that a Worker supplies.

**Architecture:** A new `src/platform.ts` defines `Platform` (jobs notify, realtime publisher, rate limit store, storage adapter factory) and in-memory defaults. `backend.start({ env, platform })` passes it to `materializeBunderstack`. The Redis transport and the in-process worker loop are removed. Job scheduling moves to an external caller of `app.jobs.tick()`, helped by `jobs.notify` and the new `app.jobs.nextDueAt()`. `Bun.randomUUIDv7`, `Bun.S3Client`, and `Bun.file` in the runtime path are replaced with portable code. A boundary test prevents a regression.

**Tech Stack:** TypeScript, Bun (`bun test` only), Drizzle ORM, oRPC 2.0.0-beta.37, BetterAuth 1.7.6, WebCrypto, `@noble/hashes`.

**Spec:** `docs/superpowers/specs/2026-09-27-workers-runtime-design.md` (stage 1). Read it before you start.

## Global Constraints

- Work only in the worktree `.claude/worktrees/next`, on branch `next`. Do not touch `main`.
- Package: `packages/bunderstack`. Run commands from `packages/bunderstack` unless a step says otherwise.
- Tests: `bun test <file>` for one file; `bun run test` from the repo root for all packages and `scripts/`.
- Typecheck: `bun run typecheck` in `packages/bunderstack`. It must pass at the end of each task.
- Tests must not touch the machine: no real network, no browser, no keychain. Use an injected `fetch` or in-memory fakes.
- No `Bun.*` call and no `from 'bun'` import in runtime code, except in the allowlist of Task 10.
- Stage 1 does not change the examples or the templates. Stage 3 migrates them.
- Stage 1 does not change `storage/thumbnails.ts`. Stage 1b replaces `Bun.Image`.
- Password hash format stays the BetterAuth scrypt format: `salt:key`, N=16384, r=16, p=1, dkLen=64, password normalized with NFKC, the salt is the 32-char hex string itself.
- Commit after each task. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match the code style around you: no semicolons, single quotes, 2-space indent, short comments that say why.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/platform.ts` (create) | `Platform` interface, in-memory defaults, `resolvePlatform()` |
| `src/backend.ts` (modify) | `StartOptions.platform`, pass it to `start()` |
| `src/runtime.ts` (modify) | Use `platform` for storage, realtime, rate limit, jobs notify; remove Redis and the worker loop |
| `src/storage/registry.ts` (modify) | `createBucketStorages(resolved, factory)` |
| `src/typeid.ts` (modify) | Portable monotonic UUIDv7 |
| `src/rate-limit.ts`, `src/handler.ts` (modify) | Rate limiter on a `RateLimitStore` |
| `src/realtime/publisher.ts`, `src/realtime/facade.ts`, `src/config.ts`, `src/env.ts` (modify) | Remove Redis, add `'platform'` transport |
| `src/jobs/queue.ts`, `src/jobs/slots.ts`, `src/jobs/worker.ts`, `src/jobs/define.ts` (modify) | `resolveRunAt`, `nextCronSlot`, `nextDueAt` |
| `src/jobs/runtime.ts` (delete) | The in-process poll loop |
| `src/storage/sigv4.ts` (create) | AWS SigV4 header and query signing on WebCrypto |
| `src/storage/s3.ts` (rewrite) | S3 adapter on `fetch` |
| `src/auth-password.ts` (create) | scrypt hash and verify, native with pure-JS fallback |
| `src/auth.ts` (modify) | `withPasswordDefaults()` |
| `src/hosted-contract.ts` (modify) | `node:fs/promises` instead of `Bun.file` |
| `scripts/dependency-boundaries.test.ts` (modify) | Guard: no Bun API in runtime sources |

---

### Task 1: Platform interface and start plumbing

**Files:**
- Create: `packages/bunderstack/src/platform.ts`
- Create: `packages/bunderstack/src/platform.test.ts`
- Modify: `packages/bunderstack/src/backend.ts` (the `StartOptions` type near line 27, the public `start` near line 265)
- Modify: `packages/bunderstack/src/runtime.ts` (`RuntimeOverrides` near line 103, `createBucketStorages(...)` call near line 509)
- Modify: `packages/bunderstack/src/storage/registry.ts` (`createBucketStorages`)
- Modify: `packages/bunderstack/src/index.ts` (type exports)

**Interfaces:**
- Produces:
  - `export interface JobsPlatform { notify(runAt: number): void | Promise<void> }`
  - `export type RateLimitHit = { allowed: boolean; resetAt: number }`
  - `export interface RateLimitStore { hit(key: string, windowMs: number, max: number, now?: number): Promise<RateLimitHit> }`
  - `export type StorageAdapterFactory = (backend: ResolvedBackend) => StorageAdapter`
  - `export interface Platform { jobs: JobsPlatform; realtime?: RealtimePublisher; rateLimit: RateLimitStore; storage: StorageAdapterFactory }`
  - `export function createMemoryRateLimitStore(): RateLimitStore`
  - `export function resolvePlatform(partial?: Partial<Platform>): Platform`
  - `StartOptions.platform?: Partial<Platform>` and `RuntimeOverrides.platform?: Partial<Platform>`
  - Inside `materializeBunderstack`: a local `const platform = resolvePlatform(overrides.platform)` that later tasks use.

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/platform.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { ResolvedBackend } from './storage/buckets'
import type { StorageAdapter } from './storage/index'

import { libsql } from './database/libsql'
import { bunderstack } from './index'
import { createMemoryRateLimitStore, resolvePlatform } from './platform'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

class MemoryAdapter implements StorageAdapter {
  readonly objects = new Map<string, Uint8Array>()
  async upload(key: string, data: Blob | ArrayBuffer) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    this.objects.set(key, new Uint8Array(bytes))
  }
  async get(key: string) {
    const value = this.objects.get(key)
    return value
      ? new Response(value as unknown as BodyInit)
      : new Response('Not found', { status: 404 })
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  async exists(key: string) {
    return this.objects.has(key)
  }
}

test('resolvePlatform fills every missing service with an in-memory default', async () => {
  const platform = resolvePlatform()
  expect(platform.realtime).toBeUndefined()
  expect(await platform.jobs.notify(1)).toBeUndefined()
  expect(typeof platform.storage).toBe('function')
  expect((await platform.rateLimit.hit('k', 1000, 1, 0)).allowed).toBe(true)
})

test('resolvePlatform keeps the services that the caller gives', () => {
  const notify = () => {}
  const platform = resolvePlatform({ jobs: { notify } })
  expect(platform.jobs.notify).toBe(notify)
})

test('memory rate limit store allows max hits per window, then resets', async () => {
  const store = createMemoryRateLimitStore()
  expect(await store.hit('a', 1000, 2, 0)).toEqual({ allowed: true, resetAt: 1000 })
  expect(await store.hit('a', 1000, 2, 10)).toEqual({ allowed: true, resetAt: 1000 })
  expect(await store.hit('a', 1000, 2, 20)).toEqual({ allowed: false, resetAt: 1000 })
  expect(await store.hit('a', 1000, 2, 1000)).toEqual({ allowed: true, resetAt: 2000 })
  expect((await store.hit('b', 1000, 2, 20)).allowed).toBe(true)
})

test('start uses the platform storage factory for every bucket', async () => {
  const seen: ResolvedBackend[] = []
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    storage: { local: true, buckets: { media: {}, docs: {} } },
  }).start({
    env: { DATABASE_URL: ':memory:' },
    platform: {
      storage: (backend) => {
        seen.push(backend)
        return new MemoryAdapter()
      },
    },
  })
  try {
    expect(seen.length).toBe(2)
    expect(seen.every((backend) => backend.type === 'local')).toBe(true)
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test src/platform.test.ts`
Expected: FAIL, `Cannot find module './platform'`.

- [ ] **Step 3: Create `src/platform.ts`**

```ts
// src/platform.ts — the services a host supplies to the core. A Worker gives
// Durable Object backed ones; tests and `bun dev` tooling get these defaults.
import type { RealtimePublisher } from './realtime/publisher'
import type { ResolvedBackend } from './storage/buckets'
import type { StorageAdapter } from './storage/index'

import { createAdapter } from './storage/registry'

export interface JobsPlatform {
  /** A job became runnable at `runAt`. The host wakes a tick at that time. */
  notify(runAt: number): void | Promise<void>
}

export type RateLimitHit = { allowed: boolean; resetAt: number }

export interface RateLimitStore {
  hit(
    key: string,
    windowMs: number,
    max: number,
    now?: number,
  ): Promise<RateLimitHit>
}

export type StorageAdapterFactory = (backend: ResolvedBackend) => StorageAdapter

export interface Platform {
  jobs: JobsPlatform
  /** Absent: the runtime uses a process-local memory publisher. */
  realtime?: RealtimePublisher
  rateLimit: RateLimitStore
  storage: StorageAdapterFactory
}

export function createMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return {
    async hit(key, windowMs, max, now = Date.now()) {
      let window = windows.get(key)
      if (!window || window.resetAt <= now) {
        window = { count: 0, resetAt: now + windowMs }
        windows.set(key, window)
      }
      window.count += 1
      return { allowed: window.count <= max, resetAt: window.resetAt }
    },
  }
}

export function resolvePlatform(partial: Partial<Platform> = {}): Platform {
  return {
    jobs: partial.jobs ?? { notify() {} },
    realtime: partial.realtime,
    rateLimit: partial.rateLimit ?? createMemoryRateLimitStore(),
    storage: partial.storage ?? createAdapter,
  }
}
```

- [ ] **Step 4: Let `createBucketStorages` take the factory**

In `src/storage/registry.ts`, replace `createBucketStorages` with:

```ts
export function createBucketStorages(
  resolved: ResolvedStorageBuckets,
  factory: (backend: ResolvedBackend) => StorageAdapter = createAdapter,
): BucketStorageRegistry {
  const registry: BucketStorageRegistry = new Map()
  for (const [name, bucket] of resolved.buckets) {
    registry.set(name, { bucket, adapter: factory(bucket.backend) })
  }
  return registry
}
```

- [ ] **Step 5: Thread `platform` through start**

In `src/backend.ts`:

```ts
import type { Platform } from './platform'

export type StartOptions = {
  env?: Record<string, string | undefined>
  /** Host services. Missing ones use in-memory defaults. */
  platform?: Partial<Platform>
}
```

and change the public `start` in the object near line 265 to:

```ts
    start: async ({ env, platform } = {}) =>
      await start(
        env ?? (process.env as Record<string, string | undefined>),
        { platform },
      ),
```

In `src/runtime.ts`, add to `RuntimeOverrides`:

```ts
  /** Host services; see src/platform.ts. */
  platform?: Partial<Platform>
```

with `import { resolvePlatform, type Platform } from './platform'` at the top. At the start of the body of the second `materializeBunderstack` overload (the implementation, after `const logger = overrides.logger ?? consoleLogger` near line 357), add:

```ts
    const platform = resolvePlatform(overrides.platform)
```

Change the registry line near line 509 to:

```ts
    const registry = createBucketStorages(config.storage, platform.storage)
```

In `src/index.ts`, next to the other type exports, add:

```ts
export type {
  JobsPlatform,
  Platform,
  RateLimitHit,
  RateLimitStore,
  StorageAdapterFactory,
} from './platform'
export { createMemoryRateLimitStore, resolvePlatform } from './platform'
```

(If `src/index.ts` only re-exports from `./runtime`, put these lines in `src/runtime.ts` next to the export block near line 941 instead, and keep one source of exports.)

- [ ] **Step 6: Run the tests and see them pass**

Run: `bun test src/platform.test.ts src/storage src/backend.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/platform.ts src/platform.test.ts src/backend.ts src/runtime.ts src/storage/registry.ts src/index.ts
git commit -m "feat(platform): inject host services through start({ platform })

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Portable monotonic UUIDv7 in typeid

**Files:**
- Modify: `packages/bunderstack/src/typeid.ts` (header comment, `generate`)
- Test: `packages/bunderstack/src/typeid.test.ts`

**Interfaces:**
- Produces: `export function uuidv7Bytes(now?: number): Uint8Array` (16 bytes, RFC 9562 version 7, variant `10`, strictly increasing between calls in one isolate).
- `generate(prefix)` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Add to `src/typeid.test.ts` (keep the existing imports; add `uuidv7Bytes` to the import from `./typeid`):

```ts
test('uuidv7Bytes sets version 7 and the RFC variant', () => {
  const bytes = uuidv7Bytes()
  expect(bytes.length).toBe(16)
  expect(bytes[6]! >> 4).toBe(7)
  expect(bytes[8]! >> 6).toBe(0b10)
})

test('uuidv7Bytes puts the millisecond timestamp in the first 48 bits', () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0, 123)
  const bytes = uuidv7Bytes(now)
  let ms = 0
  for (let i = 0; i < 6; i++) ms = ms * 256 + bytes[i]!
  expect(ms).toBeGreaterThanOrEqual(now)
})

test('generate stays sortable inside one millisecond', () => {
  const ids = Array.from({ length: 5000 }, () => generate('job'))
  expect([...ids].sort()).toEqual(ids)
  expect(new Set(ids).size).toBe(ids.length)
})

test('generate does not depend on the Bun global', () => {
  const g = globalThis as { Bun?: unknown }
  const saved = g.Bun
  try {
    g.Bun = undefined
    expect(generate('user')).toMatch(/^user_[0-9a-hjkmnp-tv-z]{26}$/)
  } finally {
    g.Bun = saved
  }
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test src/typeid.test.ts`
Expected: FAIL, `uuidv7Bytes` is not exported, and the Bun-global test throws.

- [ ] **Step 3: Implement**

In `src/typeid.ts`, change the header comment lines about `Bun.randomUUIDv7` to:

```ts
// The only runtime primitive we need is UUIDv7 bytes. `uuidv7Bytes` builds them
// from WebCrypto, so the same code runs in Bun, workerd, and celld without the
// `uuid` dependency that the reference `typeid-js` package relies on.
```

Add above `generate`:

```ts
// Monotonic state: RFC 9562 method 1, a 12-bit counter in rand_a. Seeded with
// random bits below its top bit on each new millisecond, so it can grow.
let lastMs = -1
let counter = 0

export function uuidv7Bytes(now: number = Date.now()): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  if (now > lastMs) {
    lastMs = now
    counter = ((bytes[6]! & 0x07) << 8) | bytes[7]!
  } else {
    counter += 1
    if (counter > 0xfff) {
      // Counter overflow: borrow the next millisecond, keep the order.
      lastMs += 1
      counter = 0
    }
  }
  const ms = lastMs
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
  bytes[7] = counter & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  return bytes
}
```

In `generate`, replace `const bytes = Bun.randomUUIDv7('buffer')` with:

```ts
  const bytes = uuidv7Bytes()
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test src/typeid.test.ts src/typeid-pg.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/typeid.ts src/typeid.test.ts
git commit -m "feat(typeid): generate UUIDv7 without Bun.randomUUIDv7

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rate limiter on the platform store

**Files:**
- Modify: `packages/bunderstack/src/rate-limit.ts`
- Modify: `packages/bunderstack/src/handler.ts`
- Modify: `packages/bunderstack/src/runtime.ts` (the `buildHandler({...})` call near line 860)
- Test: `packages/bunderstack/src/rate-limit.test.ts`

**Interfaces:**
- Consumes: `RateLimitStore`, `createMemoryRateLimitStore` from Task 1.
- Produces: `createRateLimiter(config, store?)`, `buildHandler({ ..., rateLimitStore? })`. The module-level `Map` is removed; limits are per app.

- [ ] **Step 1: Write the failing tests**

Add to `src/rate-limit.test.ts`:

```ts
import type { RateLimitStore } from './platform'

test('rate limiter asks the injected store with client and path', async () => {
  const calls: Array<[string, number, number]> = []
  const store: RateLimitStore = {
    async hit(key, windowMs, max) {
      calls.push([key, windowMs, max])
      return { allowed: false, resetAt: Date.now() + 5_000 }
    },
  }
  const limiter = createRateLimiter({ windowMs: 10_000, max: 3 }, store)
  const res = await limiter(
    new Request('http://localhost/api/posts', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    }),
  )
  expect(calls).toEqual([['203.0.113.9:/api/posts', 10_000, 3]])
  expect(res?.status).toBe(429)
  expect(Number(res?.headers.get('Retry-After'))).toBeGreaterThan(0)
})

test('two limiters do not share counters', async () => {
  const a = createRateLimiter({ windowMs: 60_000, max: 1 })
  const b = createRateLimiter({ windowMs: 60_000, max: 1 })
  const req = () => new Request('http://localhost/api/shared')
  expect(await a(req())).toBeNull()
  expect(await b(req())).toBeNull()
  expect((await a(req()))?.status).toBe(429)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test src/rate-limit.test.ts`
Expected: FAIL. The first test gets no store call; the second fails because the counters are shared.

- [ ] **Step 3: Implement**

Add this import as the first line of `src/rate-limit.ts`:

```ts
import { createMemoryRateLimitStore, type RateLimitStore } from './platform'
```

Then replace everything after the `RateLimitConfig` type with:

```ts
function resolveConfig(
  config: boolean | RateLimitConfig | undefined,
): RateLimitConfig | null {
  if (!config) return null
  if (config === true) return {}
  return config
}

function clientKey(req: Request): string {
  const cloudflare = req.headers.get('cf-connecting-ip')
  if (cloudflare) return cloudflare
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('x-real-ip') ?? 'local'
}

export function createRateLimiter(
  config: boolean | RateLimitConfig | undefined,
  store: RateLimitStore = createMemoryRateLimitStore(),
): (req: Request) => Promise<Response | null> {
  const resolved = resolveConfig(config)
  if (!resolved) {
    return async (_req: Request) => null
  }

  const windowMs = resolved.windowMs ?? 60_000
  const max = resolved.max ?? 100

  return async (req: Request): Promise<Response | null> => {
    if (resolved.skip?.(req)) return null

    const key = `${clientKey(req)}:${new URL(req.url).pathname}`
    const now = Date.now()
    const { allowed, resetAt } = await store.hit(key, windowMs, max, now)
    if (allowed) return null

    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000))
    return new Response(
      JSON.stringify({
        error: 'Too many requests',
        code: 'TOO_MANY_REQUESTS',
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      },
    )
  }
}
```

Remove the old `Bucket` type and the module-level `buckets` map.

In `src/handler.ts`:

```ts
import type { RateLimitStore } from './platform'

import { createRateLimiter, type RateLimitConfig } from './rate-limit'

interface HandlerParts {
  authHandler?: (req: Request) => Promise<Response>
  apiHandler?: (req: Request) => Promise<Response | null>
  rateLimit?: boolean | RateLimitConfig
  rateLimitStore?: RateLimitStore
}
```

and `const checkRateLimit = createRateLimiter(parts.rateLimit, parts.rateLimitStore)`.

In `src/runtime.ts`, in the `buildHandler({...})` call, add `rateLimitStore: platform.rateLimit,`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test src/rate-limit.test.ts src/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` (expected: no errors), then:

```bash
git add src/rate-limit.ts src/rate-limit.test.ts src/handler.ts src/runtime.ts
git commit -m "feat(rate-limit): count hits in the platform store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Realtime publisher from the platform; remove Redis

**Files:**
- Modify: `packages/bunderstack/src/realtime/publisher.ts` (remove `createRedisRealtimePublisher` and the `@orpc/bun` and `bun` imports)
- Delete: `packages/bunderstack/src/realtime/publisher.redis.test.ts`
- Modify: `packages/bunderstack/src/realtime/facade.ts` (`RealtimeTransport`)
- Modify: `packages/bunderstack/src/realtime/facade.test.ts` (the `test.each` near line 93)
- Modify: `packages/bunderstack/src/runtime.ts` (publisher block near lines 463-505, the `runWorker` message near line 657)
- Modify: `packages/bunderstack/src/config.ts` (`realtime.redis` schema near line 136, type near line 154, `resolveRealtimeRedisUrl` near line 320)
- Modify: `packages/bunderstack/src/config.test.ts` (the Redis precedence test near line 175)
- Modify: `packages/bunderstack/src/env.ts` (`REDIS_URL` near lines 45 and 136), `packages/bunderstack/src/env.test.ts` (near line 20)
- Modify: `packages/bunderstack/src/testing/infrastructure.test.ts` (near line 20)
- Modify: `packages/bunderstack/package.json` (remove the `@orpc/bun` peer), `scripts/dependency-boundaries.test.ts` (remove `'@orpc/bun'` from the peer list near line 215)
- Test: `packages/bunderstack/src/realtime/platform-publisher.test.ts` (create)

**Interfaces:**
- Consumes: `platform.realtime` from Task 1.
- Produces: `RealtimeTransport = 'disabled' | 'memory' | 'platform'`. When realtime is on and `platform.realtime` is set, the runtime uses it and reports `'platform'`; otherwise it uses `createMemoryRealtimePublisher` and reports `'memory'`. `RuntimeOverrides.forceMemoryRealtime` is removed.

- [ ] **Step 1: Write the failing test**

Create `src/realtime/platform-publisher.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { createMemoryRealtimePublisher } from './publisher'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

test('the runtime publishes through the platform publisher', async () => {
  const publisher = createMemoryRealtimePublisher()
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    realtime: true,
  }).start({
    env: { DATABASE_URL: ':memory:', REDIS_URL: 'redis://ignored.invalid' },
    platform: { realtime: publisher },
  })
  try {
    expect(app.realtime.transport).toBe('platform')
    const events: unknown[] = []
    const controller = new AbortController()
    const iterator = publisher.subscribe('change', { signal: controller.signal })
    const reading = (async () => {
      for await (const event of iterator) {
        events.push(event)
        controller.abort()
      }
    })().catch(() => {})
    await app.realtime.publish('notes', 'create', { id: 'n1' })
    await reading
    expect(events).toEqual([
      expect.objectContaining({ table: 'notes', action: 'create' }),
    ])
  } finally {
    await app.close()
  }
})

test('without a platform publisher the runtime uses memory', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    realtime: true,
  }).start({ env: { DATABASE_URL: ':memory:' } })
  try {
    expect(app.realtime.transport).toBe('memory')
  } finally {
    await app.close()
  }
})
```

Before you run it, open `src/realtime/facade.ts` and check the name and arguments of the publish method on `RealtimeFacade`. If it is not `publish(table, action, record)`, change the call in the test to the real method. Keep the assertion on `table` and `action`.

- [ ] **Step 2: Run the test and see it fail**

Run: `bun test src/realtime/platform-publisher.test.ts`
Expected: FAIL. The transport is `'memory'`, or the runtime tries to connect to Redis because `REDIS_URL` is set.

- [ ] **Step 3: Implement**

`src/realtime/publisher.ts`: delete `createRedisRealtimePublisher`, the `import type { RedisClient } from 'bun'` line, and the `import { BunRedisPublisher } from '@orpc/bun'` line. Keep everything else.

`src/realtime/facade.ts`:

```ts
export type RealtimeTransport = 'disabled' | 'memory' | 'platform'
```

`src/runtime.ts`: replace the block from `const configuredRedisUrl = ...` to the end of `const runtimeRealtimeTransport ...` with:

```ts
    const publisher = config.realtime
      ? (platform.realtime ??
        createMemoryRealtimePublisher({
          maxBufferedEvents: realtimeBufferSize,
          resumeSeconds: realtimeResumeSeconds,
        }))
      : undefined
    const runtimeRealtimeTransport: RealtimeTransport = !publisher
      ? 'disabled'
      : platform.realtime
        ? 'platform'
        : 'memory'
```

Remove `createRedisRealtimePublisher` and `resolveRealtimeRedisUrl` from the imports, and remove `forceMemoryRealtime` from `RuntimeOverrides`. In `src/testing/fixture.ts`, remove the `forceMemoryRealtime: true,` line. (Task 6 removes `runWorker` and its message, so leave that message for now if it still compiles.)

`src/config.ts`: delete the `redis: v.optional(...)` entry in the realtime schema, the `redis?: ...` field in the realtime type, and the function `resolveRealtimeRedisUrl`. `src/env.ts`: delete `REDIS_URL` from the env type and from the base object. `src/config.test.ts`: delete the test that checks Redis URL precedence. `src/env.test.ts`: delete the `REDIS_URL` input and assertion. `src/testing/infrastructure.test.ts`: remove `realtime: { redis: ... }` from the config and keep `realtime: true` if the test needs realtime. `src/realtime/facade.test.ts`: change `['redis', 'redis']` to `['platform', 'platform']`. Delete `src/realtime/publisher.redis.test.ts`.

`packages/bunderstack/package.json`: remove `"@orpc/bun"` from `peerDependencies` (and from `peerDependenciesMeta` and `devDependencies` if it is there). In `scripts/dependency-boundaries.test.ts`, remove `'@orpc/bun',` from the list in `bunderstack peer metadata matches runtime import boundaries`. Run `bun install` from the repo root to update `bun.lock`.

Search for leftovers:

Run: `grep -rn "redis\|Redis\|REDIS" src --include='*.ts' | grep -v CHANGELOG`
Expected: no match, except comments that you must also update.

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test src/realtime src/config.test.ts src/env.test.ts src/testing src/app-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` (expected: no errors), then:

```bash
git add -A src package.json ../../bun.lock ../../scripts/dependency-boundaries.test.ts
git commit -m "feat(realtime)!: take the publisher from the platform, drop Redis

REDIS_URL and realtime.redis are removed. A host passes an oRPC Publisher as
platform.realtime; without one the runtime keeps the memory publisher.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: jobs.notify on enqueue, and app.jobs.nextDueAt

**Files:**
- Modify: `packages/bunderstack/src/jobs/queue.ts` (add `resolveRunAt`, use it in `enqueueJob`)
- Modify: `packages/bunderstack/src/jobs/slots.ts` (add `nextCronSlot`)
- Modify: `packages/bunderstack/src/jobs/worker.ts` (add `nextDueAt` to the object that `createJobRunner` returns)
- Modify: `packages/bunderstack/src/jobs/define.ts` (`JobsRuntimeFacade`)
- Modify: `packages/bunderstack/src/runtime.ts` (the `jobs` facade near line 587)
- Test: `packages/bunderstack/src/jobs/slots.test.ts`, `packages/bunderstack/src/jobs/next-due.test.ts` (create), `packages/bunderstack/src/jobs/notify.test.ts` (create)

**Interfaces:**
- Consumes: `platform.jobs.notify` from Task 1.
- Produces:
  - `export function resolveRunAt(opts: EnqueueOptions, now: number): number`
  - `export function nextCronSlot(cron: ParsedCron, after: number, until: number): number | null` — first matching slot `s` with `after < s <= until`, or `null`.
  - Runner method `nextDueAt(now: number, until: number): Promise<number | null>`.
  - `JobsRuntimeFacade.nextDueAt(now?: number, until?: number): Promise<number | null>`. Defaults: `now = Date.now()`, `until = now + 24h`. The result is never earlier than `now`.
  - Each successful enqueue calls `platform.jobs.notify(runAt)`. A notify error is logged and does not fail the enqueue.

- [ ] **Step 1: Write the failing tests for `nextCronSlot`**

Add to `src/jobs/slots.test.ts` (import `nextCronSlot` from `./slots` and `parseCron` from `./cron`):

```ts
test('nextCronSlot finds the first matching slot after a timestamp', () => {
  const cron = parseCron('*/5 * * * *')
  const after = Date.UTC(2026, 0, 1, 0, 1, 30)
  expect(nextCronSlot(cron, after, after + 3_600_000)).toBe(
    Date.UTC(2026, 0, 1, 0, 5),
  )
})

test('nextCronSlot excludes the slot that equals after', () => {
  const cron = parseCron('*/5 * * * *')
  const slot = Date.UTC(2026, 0, 1, 0, 5)
  expect(nextCronSlot(cron, slot, slot + 3_600_000)).toBe(
    Date.UTC(2026, 0, 1, 0, 10),
  )
})

test('nextCronSlot returns null when no slot is inside the horizon', () => {
  const cron = parseCron('0 0 1 1 *')
  const after = Date.UTC(2026, 0, 2)
  expect(nextCronSlot(cron, after, after + 86_400_000)).toBeNull()
})
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/jobs/slots.test.ts`
Expected: FAIL, `nextCronSlot` is not exported.

- [ ] **Step 3: Implement `nextCronSlot`**

Add to `src/jobs/slots.ts`:

```ts
/**
 * The first slot matching `cron` in `(after, until]`, or null. A scheduler
 * uses it to set its next alarm; `until` bounds the search.
 */
export function nextCronSlot(
  cron: ParsedCron,
  after: number,
  until: number,
): number | null {
  const last = floorSlot(until)
  for (let s = floorSlot(after) + SLOT_MS; s <= last; s += SLOT_MS) {
    if (cronMatches(cron, s)) return s
  }
  return null
}
```

Export it from `src/jobs/index.ts` next to `slotsDue`.

Run: `bun test src/jobs/slots.test.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing tests for `nextDueAt`**

Create `src/jobs/next-due.test.ts`:

```ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { JobsDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackJobs, withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { enqueueJob } from './queue'
import { createJobRunner } from './worker'

let db: LibSQLDatabase<Record<string, never>>

beforeEach(async () => {
  ;({ db } = await createDb(
    {},
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  ))
  const merged = withInternalTables({})
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
})

const job: JobsDefs = {
  work: { kind: 'job', handler: async () => {} },
}
const now = Date.UTC(2026, 0, 1, 0, 1, 30)
const hour = 3_600_000

test('nextDueAt is null without work', async () => {
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBeNull()
})

test('nextDueAt returns the run_at of the earliest pending job', async () => {
  await enqueueJob(db, job, 'work', undefined, { runAt: now + 9_000 }, now)
  await enqueueJob(db, job, 'work', undefined, { runAt: now + 5_000 }, now)
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(now + 5_000)
})

test('nextDueAt never returns a time before now', async () => {
  await enqueueJob(db, job, 'work', undefined, { runAt: now - 60_000 }, now)
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(now)
})

test('nextDueAt includes the lease end of a running job', async () => {
  const { id } = await enqueueJob(db, job, 'work', undefined, {}, now)
  await db
    .update(bunderstackJobs)
    .set({ status: 'running', lockedUntil: now + 30_000 })
    .where(eq(bunderstackJobs.id, id))
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(now + 30_000)
})

test('nextDueAt includes the next cron slot', async () => {
  const defs: JobsDefs = {
    every5: { kind: 'cron', schedule: '*/5 * * * *', handler: async () => {} },
  }
  const runner = createJobRunner({ db, defs, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(
    Date.UTC(2026, 0, 1, 0, 5),
  )
})
```

If a `JobsDefs` literal does not type-check (for example, a required field such as `retries`), copy the minimal shape from `src/jobs/worker.test.ts` and keep the same `kind`, `schedule`, and `handler`.

- [ ] **Step 5: Run and see them fail**

Run: `bun test src/jobs/next-due.test.ts`
Expected: FAIL, `runner.nextDueAt is not a function`.

- [ ] **Step 6: Implement `nextDueAt` in the runner**

In `src/jobs/worker.ts`, add `nextCronSlot` to the import from `./slots`, and add this method to the object that `createJobRunner` returns (next to `tick`):

```ts
    /**
     * The earliest time that has work: a pending run_at, a running lease end,
     * or a cron slot not yet materialized. Never earlier than `now`; null when
     * nothing is due before `until`.
     */
    async nextDueAt(now: number, until: number): Promise<number | null> {
      const candidates: number[] = []
      const [pending] = await db
        .select({ at: sql<number | string | null>`min(${t.runAt})` })
        .from(t)
        .where(eq(t.status, 'pending'))
      if (pending?.at != null) candidates.push(Number(pending.at))
      const [running] = await db
        .select({ at: sql<number | string | null>`min(${t.lockedUntil})` })
        .from(t)
        .where(eq(t.status, 'running'))
      if (running?.at != null) candidates.push(Number(running.at))
      for (const [name, def] of Object.entries(defs)) {
        if (def.kind !== 'cron') continue
        const cursor = await cronCursor(`${CRON_PREFIX}${name}`, now)
        const slot = nextCronSlot(
          parseCron(def.schedule),
          cursor.checkedThrough,
          until,
        )
        if (slot !== null) candidates.push(slot)
      }
      if (candidates.length === 0) return null
      return Math.max(now, Math.min(...candidates))
    },
```

`t` is the jobs table handle already used in the file (`jobsTableFor(db)`); `sql` and `eq` are already imported. Run `bun test src/jobs/next-due.test.ts src/jobs/jobs.pg.test.ts` — Expected: PASS.

- [ ] **Step 7: Write the failing test for notify**

Create `src/jobs/notify.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { provision } from '../provision-schema'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

function backend() {
  return bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    jobs: (j) =>
      j.define({
        work: j.job({ input: v.object({ n: v.number() }), handler: async () => {} }),
        tick5: j.cron({ schedule: '*/5 * * * *', handler: async () => {} }),
      }),
  })
}

test('enqueue notifies the platform with the run time', async () => {
  const seen: number[] = []
  const app = await backend().start({
    env: { DATABASE_URL: ':memory:' },
    platform: { jobs: { notify: (runAt) => void seen.push(runAt) } },
  })
  try {
    await provision(app, { force: true })
    const before = Date.now()
    await app.jobs.enqueue('work', { n: 1 }, { delay: 60_000 })
    expect(seen.length).toBe(1)
    expect(seen[0]!).toBeGreaterThanOrEqual(before + 60_000)
    expect(seen[0]!).toBeLessThanOrEqual(Date.now() + 60_000)
  } finally {
    await app.close()
  }
})

test('a failing notify does not fail the enqueue', async () => {
  const app = await backend().start({
    env: { DATABASE_URL: ':memory:' },
    platform: {
      jobs: {
        notify: () => {
          throw new Error('scheduler is down')
        },
      },
    },
  })
  try {
    await provision(app, { force: true })
    await expect(app.jobs.enqueue('work', { n: 1 })).resolves.toEqual({
      id: expect.any(String),
    })
  } finally {
    await app.close()
  }
})

test('app.jobs.nextDueAt reports the next cron slot', async () => {
  const app = await backend().start({ env: { DATABASE_URL: ':memory:' } })
  try {
    await provision(app, { force: true })
    const now = Date.UTC(2026, 0, 1, 0, 1, 30)
    expect(await app.jobs.nextDueAt(now)).toBe(Date.UTC(2026, 0, 1, 0, 5))
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 8: Run and see it fail**

Run: `bun test src/jobs/notify.test.ts`
Expected: FAIL. `seen` is empty and `app.jobs.nextDueAt` is not a function.

- [ ] **Step 9: Implement notify and the facade method**

`src/jobs/queue.ts`: add

```ts
export function resolveRunAt(opts: EnqueueOptions, now: number): number {
  return opts.runAt !== undefined
    ? new Date(opts.runAt).getTime()
    : now + (opts.delay ?? 0)
}
```

and in `enqueueJob` replace the `const runAt = ...` expression with `const runAt = resolveRunAt(opts, now)`.

`src/jobs/define.ts`: add to `JobsRuntimeFacade`:

```ts
  /**
   * When the next background work is due, for a host scheduler. Never earlier
   * than `now`; null when nothing is due before `until` (default: 24 h later).
   */
  nextDueAt(now?: number, until?: number): Promise<number | null>
```

`src/runtime.ts`: import `resolveRunAt` from `./jobs/queue`. In the `jobs` facade, after the `enqueueJob(...)` call and before `return result`, add:

```ts
        const runAt = resolveRunAt(enqueueOptions, enqueueNow ?? Date.now())
        try {
          await platform.jobs.notify(runAt)
        } catch (error) {
          // The row is committed; a host that missed this wake still finds the
          // job through nextDueAt on its next safety tick.
          logger.error('[bunderstack] jobs.notify failed:', error)
        }
```

and add a method next to `tick`:

```ts
      nextDueAt(now: number = Date.now(), until: number = now + 86_400_000) {
        return jobRunner
          ? jobRunner.nextDueAt(now, until)
          : Promise.resolve(null)
      },
```

Also add `nextDueAt` wherever a test or fixture builds a `JobsRuntimeFacade` literal by hand (for example `runner()` in `src/jobs/worker.test.ts`: `nextDueAt: (now, until) => r.nextDueAt(now ?? Date.now(), until ?? Date.now() + 86_400_000)`). Find them with `grep -rn "setJobsFacade\|JobsRuntimeFacade" src`.

- [ ] **Step 10: Run the tests and see them pass**

Run: `bun test src/jobs`
Expected: PASS.

- [ ] **Step 11: Typecheck and commit**

Run: `bun run typecheck` (expected: no errors), then:

```bash
git add src/jobs src/runtime.ts
git commit -m "feat(jobs): notify the platform on enqueue and report nextDueAt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Remove the in-process worker loop and BUNDERSTACK_ROLE

**Files:**
- Delete: `packages/bunderstack/src/jobs/runtime.ts`, `packages/bunderstack/src/jobs/runtime.test.ts`
- Modify: `packages/bunderstack/src/runtime.ts` (`AppStartWorkerOptions`, `AppRunWorkerOptions`, the `startWorker`/`runWorker`/`backgroundRunning` members of `BunderstackApp`, `waitForWorkerShutdown`, the `startWorker`/`runWorker` functions near lines 626-680, the auto-start block near lines 866-879, the app object near lines 895-910, `RuntimeOverrides.backgroundAutoStart`)
- Modify: `packages/bunderstack/src/config.ts` (`background?: { autoStart?: boolean }` near line 194, and its valibot schema entry)
- Modify: `packages/bunderstack/src/env.ts` (`BunderstackRole`, `ROLES`, `BUNDERSTACK_ROLE`), `packages/bunderstack/src/env-probe.ts` (line 25)
- Modify: `packages/bunderstack/src/testing/fixture.ts` (line 85, line 176)
- Modify: `packages/bunderstack/src/jobs/index.ts` (remove exports of the deleted module)
- Modify tests: `src/jobs/integration.test.ts`, `src/env.test.ts`, `src/app-env.test.ts`, and each other file that `grep` finds in Step 1
- Test: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**
- Consumes: `app.jobs.tick()` (exists), `app.jobs.nextDueAt()` from Task 5.
- Produces: `BunderstackApp` has no `startWorker`, `runWorker`, or `backgroundRunning`. `start()` never runs background work. The config key `background` and the env var `BUNDERSTACK_ROLE` are removed. `jobRunner.pump` and `jobRunner.drain` stay in `worker.ts` (lifecycle close uses `drain`).

- [ ] **Step 1: List every use**

Run: `grep -rn "startWorker\|runWorker\|backgroundRunning\|BUNDERSTACK_ROLE\|BunderstackRole\|backgroundAutoStart\|autoStart\|jobs/runtime" src ../../scripts --include='*.ts'`
Expected: a list of the files above. Keep it; each hit must be gone after Step 4.

- [ ] **Step 2: Write the failing test**

In `src/jobs/integration.test.ts`, delete the tests that call `startWorker` or `runWorker` (near lines 57, 101, 154, 186, 211, 237) and remove `background: { autoStart: false }` and its comment from the first test. Then add:

```ts
test('start never runs background work; a host drives it with tick', async () => {
  let ran = 0
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) =>
      j.define({
        count: j.job({ handler: async () => void ran++ }),
      }),
  }).start()
  try {
    await provision(app, { force: true })
    await app.jobs.enqueue('count', undefined)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(ran).toBe(0)
    expect('startWorker' in app).toBe(false)
    expect('runWorker' in app).toBe(false)
    const result = await app.jobs.tick()
    expect(result.ran).toBe(1)
    expect(ran).toBe(1)
  } finally {
    await app.close()
  }
})
```

The 1.2 s wait is longer than the old 1 s poll interval, so the test fails while an automatic worker exists.

- [ ] **Step 3: Run and see it fail**

Run: `bun test src/jobs/integration.test.ts`
Expected: FAIL. `ran` is 1 before `tick`, because `BUNDERSTACK_ROLE` defaults to `all` and auto-starts the worker.

- [ ] **Step 4: Remove the loop, the role, and the config key**

In `src/runtime.ts`:
- Delete the types `AppStartWorkerOptions` and `AppRunWorkerOptions`, the members `startWorker`, `runWorker`, and `backgroundRunning` of `BunderstackApp`, the function `waitForWorkerShutdown`, and the local functions `startWorker` and `runWorker`.
- Delete the block that computes `roleWantsWorker`, `autoStart`, and `backgroundRunning`, and the `await startWorker()` call.
- Delete `startWorker,`, `runWorker,`, and `backgroundRunning,` from the app object.
- Delete `backgroundAutoStart` from `RuntimeOverrides`.
- Remove the imports from `./jobs/runtime` (`startJobWorker`, `WorkerHandle`, and others).
- In the exports block near line 941, remove any re-export of worker types.

Delete `src/jobs/runtime.ts` and `src/jobs/runtime.test.ts`, and remove their exports from `src/jobs/index.ts`.

In `src/config.ts`, delete `background?: { autoStart?: boolean }` and the matching schema entry. In `src/env.ts`, delete `BunderstackRole`, `ROLES`, `BUNDERSTACK_ROLE` in the type and the base object, and the validation block for it. In `src/env-probe.ts`, delete `BUNDERSTACK_ROLE: 'all',`. In `src/testing/fixture.ts`, delete `BUNDERSTACK_ROLE: 'web',` and `backgroundAutoStart: false,`.

Update the remaining tests from Step 1: delete assertions about `BUNDERSTACK_ROLE` in `src/env.test.ts` and `src/app-env.test.ts`; delete `background: {...}` from test configs; delete the checks of `backgroundRunning`.

Run the Step 1 `grep` again.
Expected: no match.

- [ ] **Step 5: Run the tests and see them pass**

Run: `bun test src/jobs src/env.test.ts src/app-env.test.ts src/testing src/messaging`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck` (expected: no errors), then:

```bash
git add -A src
git commit -m "feat(jobs)!: remove the in-process worker loop and BUNDERSTACK_ROLE

start() never runs background work. A host calls app.jobs.tick(), guided by
jobs.notify and app.jobs.nextDueAt(). startWorker, runWorker,
backgroundRunning, the background config key, and BUNDERSTACK_ROLE are gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: AWS SigV4 signing on WebCrypto

**Files:**
- Create: `packages/bunderstack/src/storage/sigv4.ts`
- Create: `packages/bunderstack/src/storage/sigv4.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string; region: string; service?: string }
  export function signRequest(input: { method: string; url: string; headers?: Record<string, string>; body?: ArrayBuffer | Uint8Array | string | null; credentials: SigV4Credentials; date?: Date; unsignedPayload?: boolean }): Promise<Record<string, string>>
  export function presignUrl(input: { method: string; url: string; credentials: SigV4Credentials; expiresIn: number; date?: Date; signedHeaders?: Record<string, string> }): Promise<string>
  ```
  `signRequest` returns the headers to send (the given headers plus `host`, `x-amz-date`, `x-amz-content-sha256`, and `authorization`). `service` defaults to `'s3'`. Keys in the returned object are lowercase.

- [ ] **Step 1: Write the failing tests**

Create `src/storage/sigv4.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { presignUrl, signRequest } from './sigv4'

const aws = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}

// AWS documentation, "Authenticating Requests: Using Query Parameters":
// GET examplebucket/test.txt, 2013-05-24T00:00:00Z, 86400 s.
test('presignUrl matches the AWS documented example', async () => {
  const url = await presignUrl({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    credentials: aws,
    expiresIn: 86_400,
    date: new Date('2013-05-24T00:00:00Z'),
  })
  expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
    'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  )
})

// Cross-check with Bun's own S3 presigner on the same instant. Bun is only a
// test oracle here; the implementation under test never calls it.
test('presignUrl agrees with Bun.S3Client for a path-style PUT', async () => {
  const client = new Bun.S3Client({
    ...aws,
    bucket: 'media',
    endpoint: 'https://storage.example.test',
  })
  const oracle = new URL(
    client.presign('uploads/a b+c.jpg', { method: 'PUT', expiresIn: 900 }),
  )
  const amzDate = oracle.searchParams.get('X-Amz-Date')!
  const date = new Date(
    amzDate.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  )
  const ours = new URL(
    await presignUrl({
      method: 'PUT',
      url: `${oracle.origin}${oracle.pathname}`,
      credentials: aws,
      expiresIn: 900,
      date,
    }),
  )
  expect(ours.pathname).toBe(oracle.pathname)
  expect(ours.searchParams.get('X-Amz-Signature')).toBe(
    oracle.searchParams.get('X-Amz-Signature'),
  )
})

test('signRequest returns lowercase headers with a SigV4 authorization', async () => {
  const headers = await signRequest({
    method: 'PUT',
    url: 'https://storage.example.test/media/a.txt',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
    credentials: aws,
    date: new Date('2026-09-27T12:00:00Z'),
  })
  expect(headers['host']).toBe('storage.example.test')
  expect(headers['x-amz-date']).toBe('20260927T120000Z')
  expect(headers['content-type']).toBe('text/plain')
  expect(headers['x-amz-content-sha256']).toBe(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  )
  expect(headers['authorization']).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260927\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  )
})
```

The hash in the last test is SHA-256 of `hello`. The first test is the documented AWS vector. The second test checks against Bun's presigner with the same `X-Amz-Date`. If the second test fails only because Bun uses a different URL style, print both URLs and make `presignUrl` follow the path encoding rule in Step 3, not the other way round.

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/storage/sigv4.test.ts`
Expected: FAIL, `Cannot find module './sigv4'`.

- [ ] **Step 3: Implement `src/storage/sigv4.ts`**

```ts
// src/storage/sigv4.ts — AWS Signature Version 4 on WebCrypto, so S3 access
// and presigned URLs work in Bun, workerd, and celld without Bun.S3Client.
export type SigV4Credentials = {
  accessKeyId: string
  secretAccessKey: string
  region: string
  service?: string
}

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

async function signingKey(
  secret: string,
  day: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), day)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/** RFC 3986 encoding, as SigV4 requires: only A-Z a-z 0-9 - _ . ~ stay. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** S3 does not normalize paths: encode each segment once, keep the slashes. */
function canonicalPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function amzDates(date: Date): { amzDate: string; day: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, day: amzDate.slice(0, 8) }
}

async function signature(
  credentials: SigV4Credentials,
  day: string,
  amzDate: string,
  canonicalRequest: string,
): Promise<{ scope: string; signature: string }> {
  const service = credentials.service ?? 's3'
  const scope = `${day}/${credentials.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const key = await signingKey(
    credentials.secretAccessKey,
    day,
    credentials.region,
    service,
  )
  return { scope, signature: hex(await hmac(key, stringToSign)) }
}

export async function signRequest(input: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: ArrayBuffer | Uint8Array | string | null
  credentials: SigV4Credentials
  date?: Date
  unsignedPayload?: boolean
}): Promise<Record<string, string>> {
  const url = new URL(input.url)
  const { amzDate, day } = amzDates(input.date ?? new Date())
  const payloadHash = input.unsignedPayload
    ? 'UNSIGNED-PAYLOAD'
    : await sha256Hex(input.body ?? '')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers[k.toLowerCase()] = v.trim()
  }
  headers['host'] = url.host
  headers['x-amz-date'] = amzDate
  headers['x-amz-content-sha256'] = payloadHash
  const names = Object.keys(headers).sort()
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n')
  const signed = await signature(input.credentials, day, amzDate, canonicalRequest)
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${signed.scope}, ` +
    `SignedHeaders=${names.join(';')}, Signature=${signed.signature}`
  return headers
}

export async function presignUrl(input: {
  method: string
  url: string
  credentials: SigV4Credentials
  expiresIn: number
  date?: Date
  signedHeaders?: Record<string, string>
}): Promise<string> {
  const url = new URL(input.url)
  const { amzDate, day } = amzDates(input.date ?? new Date())
  const service = input.credentials.service ?? 's3'
  const headers: Record<string, string> = { host: url.host }
  for (const [k, v] of Object.entries(input.signedHeaders ?? {})) {
    headers[k.toLowerCase()] = v.trim()
  }
  const names = Object.keys(headers).sort()
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set(
    'X-Amz-Credential',
    `${input.credentials.accessKeyId}/${day}/${input.credentials.region}/${service}/aws4_request`,
  )
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(input.expiresIn))
  url.searchParams.set('X-Amz-SignedHeaders', names.join(';'))
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const signed = await signature(input.credentials, day, amzDate, canonicalRequest)
  url.searchParams.set('X-Amz-Signature', signed.signature)
  return url.toString()
}
```

- [ ] **Step 4: Run and see them pass**

Run: `bun test src/storage/sigv4.test.ts`
Expected: PASS. If the Bun cross-check fails, compare the two canonical requests by logging them in a scratch copy of the test; the usual causes are path encoding (`+`, spaces) and query ordering.

- [ ] **Step 5: Commit**

```bash
git add src/storage/sigv4.ts src/storage/sigv4.test.ts
git commit -m "feat(storage): SigV4 signing and presign on WebCrypto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: S3 adapter on fetch

**Files:**
- Rewrite: `packages/bunderstack/src/storage/s3.ts`
- Rewrite: `packages/bunderstack/src/storage/s3.test.ts`

**Interfaces:**
- Consumes: `signRequest`, `presignUrl`, `SigV4Credentials` from Task 7.
- Produces: `class S3StorageAdapter implements StorageAdapter` with the same constructor fields as today (`bucket`, `region`, `accessKeyId`, `secretAccessKey`, `endpoint?`, `publicUrl?`) plus `fetch?: typeof fetch` for tests. Path-style URLs: `${endpoint ?? `https://s3.${region}.amazonaws.com`}/${bucket}/${key}`. Methods: `upload`, `get`, `delete`, `exists`, `stat`, `list`, `presignPut`, `presignGet`, `publicUrlFor`.

- [ ] **Step 1: Write the failing tests**

Replace `src/storage/s3.test.ts` with:

```ts
import { expect, test } from 'bun:test'

import { S3StorageAdapter } from './s3'

type Seen = { method: string; url: string; headers: Headers; body: string }

function fakeS3(
  respond: (seen: Seen) => Response | Promise<Response>,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    }
    seen.push(entry)
    return respond(entry)
  }) as typeof fetch
  return { fetch: f, seen }
}

const config = {
  bucket: 'media',
  region: 'auto',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  endpoint: 'https://storage.example.test',
}

test('upload PUTs the bytes with the content type and a signature', async () => {
  const s3 = fakeS3(() => new Response(null, { status: 200 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  await adapter.upload('media/a.txt', new TextEncoder().encode('hi').buffer, 'text/plain')
  expect(s3.seen[0]!.method).toBe('PUT')
  expect(s3.seen[0]!.url).toBe('https://storage.example.test/media/media/a.txt')
  expect(s3.seen[0]!.headers.get('content-type')).toBe('text/plain')
  expect(s3.seen[0]!.headers.get('authorization')).toStartWith('AWS4-HMAC-SHA256 ')
  expect(s3.seen[0]!.body).toBe('hi')
})

test('upload throws on a non-2xx answer', async () => {
  const s3 = fakeS3(() => new Response('denied', { status: 403 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  await expect(
    adapter.upload('media/a.txt', new ArrayBuffer(1), 'text/plain'),
  ).rejects.toThrow(/403/)
})

test('get streams the object with its stored content type', async () => {
  const s3 = fakeS3(
    () => new Response('bytes', { headers: { 'content-type': 'image/png' } }),
  )
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  const res = await adapter.get('media/p.png')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(await res.text()).toBe('bytes')
})

test('get answers 404 when the object is missing', async () => {
  const s3 = fakeS3(() => new Response('<Error/>', { status: 404 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  expect((await adapter.get('media/none')).status).toBe(404)
})

test('stat and exists use HEAD', async () => {
  const s3 = fakeS3((seen) =>
    seen.url.endsWith('/missing')
      ? new Response(null, { status: 404 })
      : new Response(null, {
          headers: { 'content-length': '42', 'content-type': 'image/jpeg' },
        }),
  )
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  expect(await adapter.stat('media/x.jpg')).toEqual({ size: 42, contentType: 'image/jpeg' })
  expect(await adapter.stat('media/missing')).toBeNull()
  expect(await adapter.exists('media/x.jpg')).toBe(true)
  expect(s3.seen.every((s) => s.method === 'HEAD')).toBe(true)
})

test('delete sends DELETE', async () => {
  const s3 = fakeS3(() => new Response(null, { status: 204 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  await adapter.delete('media/a.txt')
  expect(s3.seen[0]!.method).toBe('DELETE')
})

test('list follows continuation tokens and decodes XML entities', async () => {
  const pages = [
    `<ListBucketResult><Contents><Key>media/a__transforms/x&amp;y.webp</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>`,
    `<ListBucketResult><Contents><Key>media/a__transforms/z.webp</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
  ]
  const s3 = fakeS3(() => new Response(pages.shift()!))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  expect(await adapter.list('media/a__transforms/')).toEqual([
    'media/a__transforms/x&y.webp',
    'media/a__transforms/z.webp',
  ])
  const second = new URL(s3.seen[1]!.url)
  expect(second.searchParams.get('list-type')).toBe('2')
  expect(second.searchParams.get('continuation-token')).toBe('t1')
})

test('presignPut and presignGet sign without network', async () => {
  const s3 = fakeS3(() => {
    throw new Error('presign must not call fetch')
  })
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  const put = new URL(await adapter.presignPut('media/a.jpg', { expiresIn: 900 }))
  const get = new URL(await adapter.presignGet('media/a.jpg', { expiresIn: 900 }))
  expect(put.pathname).toBe('/media/media/a.jpg')
  expect(put.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  expect(put.searchParams.get('X-Amz-Signature')).not.toBe(
    get.searchParams.get('X-Amz-Signature'),
  )
})

test('publicUrlFor joins the public base and the key', () => {
  const adapter = new S3StorageAdapter({ ...config, publicUrl: 'https://cdn.test/' })
  expect(adapter.publicUrlFor('media/a.jpg')).toBe('https://cdn.test/media/a.jpg')
  expect(new S3StorageAdapter(config).publicUrlFor('media/a.jpg')).toBeUndefined()
})
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/storage/s3.test.ts`
Expected: FAIL. The current adapter ignores `fetch` and calls `Bun.S3Client`.

- [ ] **Step 3: Rewrite `src/storage/s3.ts`**

```ts
// src/storage/s3.ts — S3 on fetch + SigV4, so the adapter runs outside Bun.
import type {
  PresignGetOptions,
  PresignPutOptions,
  StorageAdapter,
} from './index'

import { presignUrl, signRequest, type SigV4Credentials } from './sigv4'

interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  publicUrl?: string
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly base: string
  private readonly credentials: SigV4Credentials
  private readonly publicUrl?: string
  private readonly fetchFn: typeof fetch

  constructor(cfg: S3Config) {
    const endpoint = (cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`).replace(/\/$/, '')
    this.base = `${endpoint}/${cfg.bucket}`
    this.credentials = {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
    }
    this.publicUrl = cfg.publicUrl
    this.fetchFn = cfg.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  private objectUrl(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  private async send(
    method: string,
    url: string,
    body?: ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers,
      body: body ?? null,
      credentials: this.credentials,
    })
    return this.fetchFn(url, { method, headers: signed, body })
  }

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void> {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    const res = await this.send('PUT', this.objectUrl(fileId), bytes, {
      'content-type': contentType,
    })
    if (!res.ok) {
      throw new Error(`[bunderstack] S3 upload failed (${res.status}): ${await res.text()}`)
    }
  }

  async get(fileId: string): Promise<Response> {
    const res = await this.send('GET', this.objectUrl(fileId))
    if (res.status === 404) return new Response('Not found', { status: 404 })
    if (!res.ok) {
      throw new Error(`[bunderstack] S3 get failed (${res.status})`)
    }
    return new Response(res.body, {
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
      },
    })
  }

  async delete(fileId: string): Promise<void> {
    const res = await this.send('DELETE', this.objectUrl(fileId))
    if (!res.ok && res.status !== 404) {
      throw new Error(`[bunderstack] S3 delete failed (${res.status})`)
    }
  }

  async exists(fileId: string): Promise<boolean> {
    return (await this.stat(fileId)) !== null
  }

  async stat(key: string): Promise<{ size: number; contentType: string } | null> {
    const res = await this.send('HEAD', this.objectUrl(key))
    if (!res.ok) return null
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? '',
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const url = new URL(this.base)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', prefix)
      if (token) url.searchParams.set('continuation-token', token)
      const res = await this.send('GET', url.toString())
      if (!res.ok) throw new Error(`[bunderstack] S3 list failed (${res.status})`)
      const xml = await res.text()
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
        keys.push(decodeXml(match[1]!))
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
        : undefined
    } while (token)
    return keys
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return presignUrl({
      method: 'PUT',
      url: this.objectUrl(key),
      credentials: this.credentials,
      expiresIn: opts.expiresIn,
    })
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    return presignUrl({
      method: 'GET',
      url: this.objectUrl(key),
      credentials: this.credentials,
      expiresIn: opts.expiresIn,
    })
  }

  publicUrlFor(key: string): string | undefined {
    if (!this.publicUrl) return undefined
    return `${this.publicUrl.replace(/\/$/, '')}/${key}`
  }
}
```

`presignPut` does not sign `content-type`. The old adapter passed `type` to Bun's presigner, but `operations.confirmUpload` checks the stored type after upload, so an unsigned type is enough. Keep this behavior and do not add a signed header.

- [ ] **Step 4: Run and see them pass**

Run: `bun test src/storage`
Expected: PASS, including `src/storage/registry.test.ts` and `src/query/client-upload.test.ts`.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` (expected: no errors), then:

```bash
git add src/storage/s3.ts src/storage/s3.test.ts
git commit -m "feat(storage): S3 adapter on fetch and SigV4, without Bun.S3Client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Portable password hashing in the BetterAuth format

**Files:**
- Create: `packages/bunderstack/src/auth-password.ts`
- Create: `packages/bunderstack/src/auth-password.test.ts`
- Modify: `packages/bunderstack/src/auth.ts` (add `withPasswordDefaults`)
- Modify: `packages/bunderstack/src/runtime.ts` (apply it where `withEmailAuthDefaults(` is called, near line 412)
- Modify: `packages/bunderstack/package.json` (add `"@noble/hashes": "^2.3.0"` to `dependencies`)

**Interfaces:**
- Produces:
  - `export function createPasswordHasher(options?: { nativeScrypt?: ScryptFn | null }): { hash(password: string): Promise<string>; verify(input: { hash: string; password: string }): Promise<boolean> }`
  - `type ScryptFn = (password: string, salt: string, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Uint8Array>`
  - `export const passwordHasher` (default instance: native `node:crypto` scrypt when it works, otherwise `@noble/hashes`).
  - `export function withPasswordDefaults(cfg: BetterAuthConfig): BetterAuthConfig` — sets `emailAndPassword.password` only when `emailAndPassword.enabled` is true and the user gave no `password` option.

- [ ] **Step 1: Add the dependency**

Run from the repo root: `bun add --cwd packages/bunderstack @noble/hashes@^2.3.0`
Expected: `packages/bunderstack/package.json` lists it under `dependencies`. Then check the boundary test: `bun test scripts/dependency-boundaries.test.ts` from the repo root. If `manifests declare correct peers and dependencies` has an allowlist of runtime dependencies, add `@noble/hashes` to it.

- [ ] **Step 2: Write the failing tests**

Create `src/auth-password.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { hashPassword as betterAuthHash } from 'better-auth/crypto'

import { createPasswordHasher, passwordHasher, withPasswordDefaults } from './auth-password'

const pureJs = createPasswordHasher({ nativeScrypt: null })

test('a hash made by BetterAuth verifies with both implementations', async () => {
  const hash = await betterAuthHash('correct horse')
  expect(await passwordHasher.verify({ hash, password: 'correct horse' })).toBe(true)
  expect(await pureJs.verify({ hash, password: 'correct horse' })).toBe(true)
  expect(await pureJs.verify({ hash, password: 'wrong' })).toBe(false)
})

test('a hash made by the pure-JS path verifies with the native path', async () => {
  const hash = await pureJs.hash('pässwörd')
  expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
  expect(await passwordHasher.verify({ hash, password: 'pässwörd' })).toBe(true)
})

test('a native scrypt that throws falls back to pure JS', async () => {
  const hasher = createPasswordHasher({
    nativeScrypt: async () => {
      throw Object.assign(new Error('The scrypt method is not implemented'), {
        code: 'ERR_METHOD_NOT_IMPLEMENTED',
      })
    },
  })
  const hash = await hasher.hash('x')
  expect(await pureJs.verify({ hash, password: 'x' })).toBe(true)
})

test('withPasswordDefaults fills the hasher only when email auth is on', () => {
  expect(withPasswordDefaults({}).emailAndPassword).toBeUndefined()
  const on = withPasswordDefaults({ emailAndPassword: { enabled: true } })
  expect(typeof on.emailAndPassword?.password?.hash).toBe('function')
  const own = { hash: async () => 'h', verify: async () => true }
  const kept = withPasswordDefaults({
    emailAndPassword: { enabled: true, password: own },
  })
  expect(kept.emailAndPassword?.password).toBe(own)
})
```

(`withPasswordDefaults` lives in `auth-password.ts` so `auth.ts` does not grow; `auth.ts` re-exports it in Step 4.)

- [ ] **Step 3: Run and see them fail**

Run: `bun test src/auth-password.test.ts`
Expected: FAIL, `Cannot find module './auth-password'`.

- [ ] **Step 4: Implement**

Create `src/auth-password.ts`:

```ts
// src/auth-password.ts — BetterAuth's scrypt password format, with a plain-JS
// fallback. BetterAuth picks node:crypto scrypt through its `workerd` and
// `node` export conditions; celld implements neither, so we choose at runtime.
import type { BetterAuthOptions } from 'better-auth'

import { scryptAsync } from '@noble/hashes/scrypt.js'
import * as nodeCrypto from 'node:crypto'

type ScryptFn = (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Uint8Array>

// Must match @better-auth/utils/password: existing hashes stay valid.
const PARAMS = { N: 16384, r: 16, p: 1 } as const
const KEY_LENGTH = 64
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const nodeScrypt: ScryptFn | null =
  typeof nodeCrypto.scrypt === 'function'
    ? (password, salt, keylen, options) =>
        new Promise((resolve, reject) =>
          nodeCrypto.scrypt(password, salt, keylen, options, (error, key) =>
            error ? reject(error) : resolve(new Uint8Array(key)),
          ),
        )
    : null

const pureScrypt: ScryptFn = (password, salt, keylen, options) =>
  scryptAsync(password, salt, { ...options, dkLen: keylen })

export function createPasswordHasher(
  options: { nativeScrypt?: ScryptFn | null } = {},
) {
  let native = options.nativeScrypt === undefined ? nodeScrypt : options.nativeScrypt

  async function derive(password: string, salt: string): Promise<Uint8Array> {
    const input = password.normalize('NFKC')
    const opts = { ...PARAMS, maxmem: MAXMEM }
    if (native) {
      try {
        return await native(input, salt, KEY_LENGTH, opts)
      } catch {
        // celld: "The scrypt method is not implemented". Stop trying.
        native = null
      }
    }
    return pureScrypt(input, salt, KEY_LENGTH, opts)
  }

  return {
    async hash(password: string): Promise<string> {
      const salt = toHex(crypto.getRandomValues(new Uint8Array(16)))
      return `${salt}:${toHex(await derive(password, salt))}`
    },
    async verify({ hash, password }: { hash: string; password: string }): Promise<boolean> {
      const [salt, key] = hash.split(':')
      if (!salt || !key) throw new Error('Invalid password hash')
      return toHex(await derive(password, salt)) === key
    },
  }
}

export const passwordHasher = createPasswordHasher()

/** Only fills a gap: a user-supplied password hasher always wins. */
export function withPasswordDefaults<T extends Pick<BetterAuthOptions, 'emailAndPassword'>>(
  cfg: T,
): T {
  if (!cfg.emailAndPassword?.enabled || cfg.emailAndPassword.password) return cfg
  return {
    ...cfg,
    emailAndPassword: {
      ...cfg.emailAndPassword,
      password: { hash: passwordHasher.hash, verify: passwordHasher.verify },
    },
  }
}
```

If `BetterAuthOptions` is not exported from `'better-auth'` in 1.7.6, use the same `BetterAuthConfig` type that `src/auth.ts` imports.

In `src/auth.ts`, add `export { withPasswordDefaults } from './auth-password'`. In `src/runtime.ts`, wrap the existing call: where the code does `withEmailAuthDefaults(cfg, ...)`, change it to `withEmailAuthDefaults(withPasswordDefaults(cfg), ...)` (use the real variable name at that line) and import `withPasswordDefaults` from `./auth`.

- [ ] **Step 5: Run and see them pass**

Run: `bun test src/auth-password.test.ts src/auth-email.test.ts src/access.integration.test.ts src/auth.test.ts`
Expected: PASS. The pure-JS tests take up to a few seconds each; that is normal for scrypt.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck` (expected: no errors), then:

```bash
git add src/auth-password.ts src/auth-password.test.ts src/auth.ts src/runtime.ts package.json ../../bun.lock
git commit -m "feat(auth): scrypt passwords with a pure-JS fallback

Same hash format as BetterAuth, so existing hashes stay valid. Native
node:crypto scrypt when it works; @noble/hashes where it is not implemented
(celld).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: hosted-contract without Bun.file, and the boundary guard

**Files:**
- Modify: `packages/bunderstack/src/hosted-contract.ts` (`assertHostedBlueprintFile`)
- Test: `packages/bunderstack/src/hosted-contract.test.ts` (create)
- Modify: `scripts/dependency-boundaries.test.ts` (add one test)
- Modify: `CHANGELOG.md`, `packages/bunderstack/CHANGELOG.md` (add an `Unreleased` section)

**Interfaces:**
- Consumes: all previous tasks. The guard test fails until Tasks 2, 4, 6, and 8 are done.

- [ ] **Step 1: Write the failing tests**

Create `src/hosted-contract.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertHostedBlueprintFile } from './hosted-contract'

test('a missing hosted blueprint file fails with its path, without Bun.file', async () => {
  const g = globalThis as { Bun?: unknown }
  const saved = g.Bun
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-hosted-'))
  try {
    g.Bun = undefined
    const path = join(dir, 'missing.yaml')
    await expect(
      assertHostedBlueprintFile({} as never, path),
    ).rejects.toThrow(`hosted blueprint does not exist: ${path}`)
  } finally {
    g.Bun = saved
    await rm(dir, { recursive: true, force: true })
  }
})
```

Add to `scripts/dependency-boundaries.test.ts`, inside the `describe` block:

```ts
  test('runtime sources call no Bun API outside the Bun-only allowlist', async () => {
    // Build tools, local-disk storage, Bun database drivers, and testing run
    // only under Bun. Everything else must run in workerd and celld.
    const allowed = [
      /\/src\/cli(-skills)?\.ts$/,
      /\/src\/blueprint-generator\.ts$/,
      /\/src\/provision-runtime\.ts$/,
      /\/src\/storage\/local\.ts$/,
      /\/src\/storage\/thumbnails\.ts$/, // stage 1b replaces Bun.Image
      /\/src\/database\/bun-[a-z-]+\.ts$/,
      /\/src\/testing(\/|\.ts$)/,
    ]
    const forbidden = [/\bBun\.[A-Za-z]/, /from ['"]bun['"]/]
    const offenders: string[] = []
    for (const path of await sourceFiles(
      join(repoRoot, 'packages', 'bunderstack', 'src'),
    )) {
      if (allowed.some((pattern) => pattern.test(path))) continue
      const source = await Bun.file(path).text()
      // Comments may name Bun APIs; only code counts.
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      if (forbidden.some((pattern) => pattern.test(code))) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/hosted-contract.test.ts` (in `packages/bunderstack`) — Expected: FAIL, `Bun is not defined` or a TypeError from `Bun.file`.
Run: `bun test scripts/dependency-boundaries.test.ts` (in the repo root) — Expected: FAIL, with `src/hosted-contract.ts` in `offenders`.

- [ ] **Step 3: Implement**

In `src/hosted-contract.ts`, add `import { readFile } from 'node:fs/promises'` and replace `assertHostedBlueprintFile` with:

```ts
export async function assertHostedBlueprintFile(
  manifest: BunderstackManifest,
  path: string,
): Promise<void> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new Error(`[bunderstack] hosted blueprint does not exist: ${path}`)
  }
  assertManifestMatchesBlueprint(manifest, source)
}
```

Run the guard again. If it lists another file, remove the Bun call from that file with the same approach (a portable API), unless the file is a Bun-only tool; then add it to `allowed` with a comment that says why.

- [ ] **Step 4: Add the changelog section**

At the top of both `CHANGELOG.md` and `packages/bunderstack/CHANGELOG.md`, under the intro paragraph, add:

```markdown
## [Unreleased] — 1.0.0 (branch `next`)

### Changed

- `backend.start({ env, platform })` takes host services: `jobs.notify`,
  `realtime`, `rateLimit`, and `storage`. Missing ones use in-memory defaults.
- `app.jobs.nextDueAt(now?, until?)` tells a host scheduler when the next
  background work is due. Each enqueue calls `platform.jobs.notify(runAt)`.
- TypeIDs, S3 storage, password hashing, and the hosted blueprint check no
  longer use Bun APIs, so the core runs in workerd and celld. The password hash
  format does not change.

### Removed

- The Redis realtime transport, `REDIS_URL`, and `realtime.redis`. A host
  passes an oRPC `Publisher` as `platform.realtime`.
- The in-process worker: `app.startWorker()`, `app.runWorker()`,
  `app.backgroundRunning`, the `background` config key, and
  `BUNDERSTACK_ROLE`. A host calls `app.jobs.tick()`.
```

- [ ] **Step 5: Run the full suite and typecheck**

Run (repo root): `bun run test`
Expected: exit code 0.
Run (`packages/bunderstack`): `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/hosted-contract.ts src/hosted-contract.test.ts ../../scripts/dependency-boundaries.test.ts ../../CHANGELOG.md CHANGELOG.md
git commit -m "feat(core): read the hosted blueprint without Bun.file; guard Bun APIs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan

- `storage/thumbnails.ts` (`Bun.Image`): stage 1b.
- `bunderstack/workers`, the Durable Objects, and `wrangler.json`: stage 2.
- Examples and templates (`examples/*/src/worker.ts`, `templates/*/src/worker.ts` still call `runWorker`): stage 3.
- `scripts/publish-changed.ts` with `--tag next`: stage 4. Do not publish anything from this branch.
