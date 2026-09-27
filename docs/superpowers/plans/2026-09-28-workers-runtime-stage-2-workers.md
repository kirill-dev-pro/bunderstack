# Workers Runtime Stage 2 (`bunderstack/workers`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a bunderstack app as a Worker on Cloudflare or celld: a `createWorker(backend)` entry, three Durable Objects (`Scheduler`, `RealtimeHub`, `RateLimiter`), an R2 storage adapter, a generated `wrangler.json`, and an integration run on celld and workerd.

**Architecture:** `src/workers/` holds all Worker code. It builds a stage 1 `Platform` from bindings: jobs notify the `Scheduler` DO, realtime goes through a `Publisher` whose other side is a `MemoryPublisher` inside the `RealtimeHub` DO, rate limits use one `RateLimiter` DO per key, and each storage bucket uses an R2 binding. `createWorker(backend)` returns `{ handler, durableObjects }`, because the `Scheduler` needs the backend. The DO classes are plain classes with `fetch` and `alarm`, not `cloudflare:workers` subclasses, so `bun test` can run them with in-memory fakes. `bunderstack wrangler` writes `wrangler.json` from the backend manifest, with `triggers.crons` from the declared cron schedules so that cron runs even without traffic.

**Tech Stack:** TypeScript, Workers API (Durable Objects with alarms, R2, static assets, Cron Triggers), `@orpc/publisher`, celld 0.6.0, wrangler 4 (through `bunx` in the integration script only).

**Spec:** `docs/superpowers/specs/2026-09-27-workers-runtime-design.md` (stage 2). Stage 1 plan: `docs/superpowers/plans/2026-09-27-workers-runtime-stage-1-core.md`.

## Global Constraints

- Worktree `.claude/worktrees/next`, branch `next`. Do not touch `main`. Do not push.
- Run commands from `packages/bunderstack` unless a step says otherwise.
- No `Bun.*` and no `from 'bun'` in `src/workers/**` or `src/testing/workers-fakes.ts`. The guard test in `scripts/dependency-boundaries.test.ts` enforces it.
- No import of `cloudflare:workers` or `@cloudflare/workers-types`. Worker types are local minimal interfaces in `src/workers/types.ts`.
- Default `bun test` must not start processes, open ports, or use the network. The integration run is a separate script.
- Typecheck (`bun run typecheck`) and the task's tests pass BEFORE each commit. Run them sequentially, never in parallel with `git commit`.
- Format changed files with `bunx oxfmt <files>` before each commit. Do not format unrelated files.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/platform.ts`, `src/storage/registry.ts` (modify) | Storage factory also receives the `ResolvedBucket` |
| `src/workers/types.ts` (create) | Minimal Worker, DO, and R2 interfaces |
| `src/testing/workers-fakes.ts` (create) | In-memory DO namespace, DO state with alarms, R2 bucket |
| `src/workers/r2.ts` (create) | `R2StorageAdapter`, `bucketBindingName`, storage factory for Workers |
| `src/workers/rate-limiter.ts` (create) | `RateLimiter` DO and `durableRateLimitStore` |
| `src/workers/realtime-hub.ts` (create) | `RealtimeHub` DO and `HubPublisher` |
| `src/workers/scheduler.ts` (create) | `createSchedulerClass(backend)` |
| `src/workers/app.ts` (create) | Per-isolate app cache and `workerPlatform(env)` |
| `src/workers/index.ts` (create) | `createWorker(backend)` and public exports |
| `src/workers/wrangler.ts` (create) | `buildWranglerConfig(manifest, options)` and the CLI command |
| `src/cli.ts` (modify) | `bunderstack wrangler` |
| `package.json` (modify) | `./workers` export, `esbuild` devDependency |
| `examples/workers-probe/**` (create) | App used by the integration run |
| `scripts/workers-integration.ts` (create) | Starts sqld and a runtime, runs scenarios |

---

### Task 1: Storage factory receives the bucket

**Files:**
- Modify: `packages/bunderstack/src/platform.ts` (`StorageAdapterFactory`)
- Modify: `packages/bunderstack/src/storage/registry.ts` (`createBucketStorages`)
- Test: `packages/bunderstack/src/platform.test.ts`

**Interfaces:**
- Produces: `export type StorageAdapterFactory = (backend: ResolvedBackend, bucket: ResolvedBucket) => StorageAdapter`. `createAdapter` stays compatible (it ignores the second argument).

- [ ] **Step 1: Failing test.** In `src/platform.test.ts`, in `start uses the platform storage factory for every bucket`, change the factory to `(backend, bucket) => { seen.push(backend); names.push(bucket.name); return new MemoryAdapter() }` with `const names: string[] = []`, and add `expect(names.sort()).toEqual(['docs', 'media'])`.
- [ ] **Step 2:** `bun test src/platform.test.ts` — Expected: FAIL (`bucket` is undefined).
- [ ] **Step 3: Implement.** In `src/platform.ts`: `import type { ResolvedBackend, ResolvedBucket } from './storage/buckets'` and

```ts
export type StorageAdapterFactory = (
  backend: ResolvedBackend,
  bucket: ResolvedBucket,
) => StorageAdapter
```

In `src/storage/registry.ts`: parameter `factory: StorageAdapterFactory = createAdapter` (import the type from `../platform`), and `adapter: factory(bucket.backend, bucket)`.
- [ ] **Step 4:** `bun test src/platform.test.ts src/storage` and `bun run typecheck` — Expected: PASS, no errors.
- [ ] **Step 5: Commit** `feat(platform): pass the bucket to the storage factory`.

---

### Task 2: Worker types, fakes, and the R2 adapter

**Files:**
- Create: `packages/bunderstack/src/workers/types.ts`
- Create: `packages/bunderstack/src/testing/workers-fakes.ts`
- Create: `packages/bunderstack/src/workers/r2.ts`
- Test: `packages/bunderstack/src/workers/r2.test.ts`

**Interfaces:**
- Produces (`types.ts`):

```ts
export interface DurableObjectStorageLike {
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
}
export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike
}
export interface FetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): FetcherLike
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}
export interface R2ObjectLike {
  key: string
  size: number
  httpMetadata?: { contentType?: string }
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream
}
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<R2ObjectBodyLike | null>
  head(key: string): Promise<R2ObjectLike | null>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>
}
export type WorkerEnv = {
  SCHEDULER?: DurableObjectNamespaceLike
  REALTIME?: DurableObjectNamespaceLike
  RATE_LIMITER?: DurableObjectNamespaceLike
  ASSETS?: FetcherLike
  [binding: string]: unknown
}
export function stub(namespace: DurableObjectNamespaceLike, name: string): FetcherLike {
  return namespace.get(namespace.idFromName(name))
}
```

- Produces (`testing/workers-fakes.ts`): `createFakeState(): DurableObjectStateLike & { alarmAt(): number | null }`, `createFakeNamespace<T extends { fetch(request: Request): Promise<Response> }>(make: (state: DurableObjectStateLike, name: string) => T): DurableObjectNamespaceLike & { instance(name: string): T; state(name: string): ReturnType<typeof createFakeState> }`, `createFakeR2(): R2BucketLike & { objects: Map<string, { bytes: Uint8Array; contentType?: string }> }`.
- Produces (`r2.ts`): `bucketBindingName(bucketName: string): string` (`BUCKET_` + uppercase, non `[A-Z0-9]` to `_`), `class R2StorageAdapter implements StorageAdapter` (`constructor(bucket: R2BucketLike, presigner?: S3StorageAdapter)`), `workerStorageFactory(env: WorkerEnv): StorageAdapterFactory`.

- [ ] **Step 1: Write `types.ts` and `testing/workers-fakes.ts`.**

`src/testing/workers-fakes.ts`:

```ts
// In-memory stand-ins for Worker bindings, so Durable Object classes and the
// Worker entry run under `bun test`. Not a full emulation: alarms fire only
// when a test calls `alarm()`.
import type {
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
  R2BucketLike,
  R2ObjectLike,
} from '../workers/types'

export function createFakeState() {
  let alarm: number | null = null
  const state: DurableObjectStateLike & { alarmAt(): number | null } = {
    storage: {
      async getAlarm() {
        return alarm
      },
      async setAlarm(time) {
        alarm = typeof time === 'number' ? time : time.getTime()
      },
      async deleteAlarm() {
        alarm = null
      },
    },
    alarmAt: () => alarm,
  }
  return state
}

export function createFakeNamespace<
  T extends { fetch(request: Request): Promise<Response> },
>(make: (state: DurableObjectStateLike, name: string) => T) {
  const instances = new Map<string, { object: T; state: ReturnType<typeof createFakeState> }>()
  const entry = (name: string) => {
    let found = instances.get(name)
    if (!found) {
      const state = createFakeState()
      found = { object: make(state, name), state }
      instances.set(name, found)
    }
    return found
  }
  const namespace: DurableObjectNamespaceLike & {
    instance(name: string): T
    state(name: string): ReturnType<typeof createFakeState>
  } = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (input, init) => entry(String(id)).object.fetch(new Request(input, init)),
    }),
    instance: (name) => entry(name).object,
    state: (name) => entry(name).state,
  }
  return namespace
}

export function createFakeR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const meta = (key: string): R2ObjectLike | null => {
    const found = objects.get(key)
    return found
      ? { key, size: found.bytes.byteLength, httpMetadata: { contentType: found.contentType } }
      : null
  }
  const bucket: R2BucketLike & { objects: typeof objects } = {
    objects,
    async put(key, value, options) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(await new Response(value).arrayBuffer())
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
      return meta(key)
    },
    async get(key) {
      const found = objects.get(key)
      if (!found) return null
      return { ...meta(key)!, body: new Response(found.bytes as unknown as BodyInit).body! }
    },
    async head(key) {
      return meta(key)
    },
    async delete(key) {
      objects.delete(key)
    },
    async list(options) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).sort()
      const start = options?.cursor ? Number(options.cursor) : 0
      const page = keys.slice(start, start + 2)
      const truncated = start + 2 < keys.length
      return {
        objects: page.map((k) => meta(k)!),
        truncated,
        cursor: truncated ? String(start + 2) : undefined,
      }
    },
  }
  return bucket
}
```

(The fake R2 `list` pages by two keys, so the adapter's cursor loop is exercised.)

- [ ] **Step 2: Failing tests.** Create `src/workers/r2.test.ts`:

```ts
import { expect, test } from 'bun:test'

import type { ResolvedBucket } from '../storage/buckets'

import { S3StorageAdapter } from '../storage/s3'
import { createFakeR2 } from '../testing/workers-fakes'
import { bucketBindingName, R2StorageAdapter, workerStorageFactory } from './r2'

const bucket = (name: string, backend: ResolvedBucket['backend']): ResolvedBucket => ({
  name,
  backend,
  visibility: 'private',
  access: { create: 'authenticated', get: 'owner', delete: 'owner' },
  transforms: false,
})

test('bucketBindingName follows the wrangler.json convention', () => {
  expect(bucketBindingName('media')).toBe('BUCKET_MEDIA')
  expect(bucketBindingName('user-avatars')).toBe('BUCKET_USER_AVATARS')
})

test('R2 adapter stores, reads, stats, lists, and deletes', async () => {
  const r2 = createFakeR2()
  const adapter = new R2StorageAdapter(r2)
  await adapter.upload('media/a.png', new TextEncoder().encode('png').buffer, 'image/png')
  await adapter.upload('media/a.png__transforms/1.webp', new ArrayBuffer(2), 'image/webp')
  await adapter.upload('media/a.png__transforms/2.webp', new ArrayBuffer(2), 'image/webp')
  await adapter.upload('media/a.png__transforms/3.webp', new ArrayBuffer(2), 'image/webp')
  const res = await adapter.get('media/a.png')
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(await res.text()).toBe('png')
  expect(await adapter.stat('media/a.png')).toEqual({ size: 3, contentType: 'image/png' })
  expect(await adapter.exists('media/none')).toBe(false)
  expect((await adapter.get('media/none')).status).toBe(404)
  expect(await adapter.list('media/a.png__transforms/')).toEqual([
    'media/a.png__transforms/1.webp',
    'media/a.png__transforms/2.webp',
    'media/a.png__transforms/3.webp',
  ])
  await adapter.delete('media/a.png')
  expect(await adapter.exists('media/a.png')).toBe(false)
})

test('R2 adapter presigns only when an S3 presigner is present', async () => {
  const plain = new R2StorageAdapter(createFakeR2())
  expect(plain.presignPut).toBeUndefined()
  const s3 = new S3StorageAdapter({
    bucket: 'b', region: 'auto', accessKeyId: 'k', secretAccessKey: 's',
    endpoint: 'https://r2.example.test',
  })
  const signed = new R2StorageAdapter(createFakeR2(), s3)
  const url = new URL(await signed.presignPut!('media/a.jpg', { expiresIn: 60 }))
  expect(url.pathname).toBe('/b/media/a.jpg')
})

test('workerStorageFactory uses the R2 binding and S3 keys for presign', () => {
  const factory = workerStorageFactory({ BUCKET_MEDIA: createFakeR2() })
  const local = factory({ type: 'local', path: './uploads' }, bucket('media', { type: 'local', path: './uploads' }))
  expect(local).toBeInstanceOf(R2StorageAdapter)
  expect(local.presignPut).toBeUndefined()
  const s3Backend = {
    type: 's3' as const, bucket: 'b', region: 'auto', accessKeyId: 'k',
    secretAccessKey: 's', endpoint: 'https://r2.example.test',
  }
  expect(factory(s3Backend, bucket('media', s3Backend)).presignPut).toBeDefined()
})

test('workerStorageFactory falls back to S3 on fetch, and rejects local without R2', () => {
  const factory = workerStorageFactory({})
  const s3Backend = {
    type: 's3' as const, bucket: 'b', region: 'auto', accessKeyId: 'k',
    secretAccessKey: 's', endpoint: 'https://r2.example.test',
  }
  expect(factory(s3Backend, bucket('docs', s3Backend))).toBeInstanceOf(S3StorageAdapter)
  expect(() =>
    factory({ type: 'local', path: './uploads' }, bucket('docs', { type: 'local', path: './uploads' })),
  ).toThrow('storage bucket "docs" needs the R2 binding BUCKET_DOCS')
})
```

- [ ] **Step 3:** `bun test src/workers/r2.test.ts` — Expected: FAIL (`./r2` missing).
- [ ] **Step 4: Implement `src/workers/r2.ts`.**

```ts
// src/workers/r2.ts — storage on an R2 binding. Presign needs S3 keys to the
// same bucket; without them uploads go through the Worker (proxy mode).
import type { StorageAdapterFactory } from '../platform'
import type { PresignGetOptions, PresignPutOptions, StorageAdapter } from '../storage/index'
import type { R2BucketLike, WorkerEnv } from './types'

import { S3StorageAdapter } from '../storage/s3'

export function bucketBindingName(bucketName: string): string {
  return `BUCKET_${bucketName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export class R2StorageAdapter implements StorageAdapter {
  presignPut?: (key: string, opts: PresignPutOptions) => Promise<string>
  presignGet?: (key: string, opts: PresignGetOptions) => Promise<string>
  publicUrlFor?: (key: string) => string | undefined

  constructor(
    private readonly bucket: R2BucketLike,
    presigner?: S3StorageAdapter,
  ) {
    if (presigner) {
      this.presignPut = (key, opts) => presigner.presignPut(key, opts)
      this.presignGet = (key, opts) => presigner.presignGet(key, opts)
      this.publicUrlFor = (key) => presigner.publicUrlFor(key)
    }
  }

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await this.bucket.put(fileId, bytes, { httpMetadata: { contentType } })
  }

  async get(fileId: string): Promise<Response> {
    const object = await this.bucket.get(fileId)
    if (!object) return new Response('Not found', { status: 404 })
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      },
    })
  }

  async delete(fileId: string) {
    await this.bucket.delete(fileId)
  }

  async exists(fileId: string) {
    return (await this.bucket.head(fileId)) !== null
  }

  async stat(key: string) {
    const object = await this.bucket.head(key)
    return object
      ? { size: object.size, contentType: object.httpMetadata?.contentType ?? '' }
      : null
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor })
      keys.push(...page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return keys
  }
}

export function workerStorageFactory(env: WorkerEnv): StorageAdapterFactory {
  return (backend, bucket) => {
    const binding = env[bucketBindingName(bucket.name)] as R2BucketLike | undefined
    const s3 = backend.type === 's3' ? new S3StorageAdapter(backend) : undefined
    if (binding) return new R2StorageAdapter(binding, s3)
    if (s3) return s3
    throw new Error(
      `[bunderstack] storage bucket "${bucket.name}" needs the R2 binding ${bucketBindingName(bucket.name)}`,
    )
  }
}
```

- [ ] **Step 5:** `bun test src/workers/r2.test.ts`, then `bun run typecheck` — Expected: PASS, no errors.
- [ ] **Step 6: Commit** `feat(workers): R2 storage adapter and Worker binding types`.

---

### Task 3: `RateLimiter` Durable Object

**Files:**
- Create: `packages/bunderstack/src/workers/rate-limiter.ts`
- Test: `packages/bunderstack/src/workers/rate-limiter.test.ts`

**Interfaces:**
- Consumes: `createMemoryRateLimitStore`, `RateLimitStore` (stage 1), `stub`, `DurableObjectNamespaceLike`, `DurableObjectStateLike`.
- Produces: `class RateLimiter { constructor(state: DurableObjectStateLike, env: unknown); fetch(request: Request): Promise<Response> }`, `durableRateLimitStore(namespace: DurableObjectNamespaceLike): RateLimitStore`.

- [ ] **Step 1: Failing test.**

```ts
import { expect, test } from 'bun:test'

import { createFakeNamespace } from '../testing/workers-fakes'
import { durableRateLimitStore, RateLimiter } from './rate-limiter'

test('one RateLimiter instance per key counts a fixed window', async () => {
  const namespace = createFakeNamespace((state) => new RateLimiter(state, {}))
  const store = durableRateLimitStore(namespace)
  expect(await store.hit('ip:/api/a', 1000, 1, 0)).toEqual({ allowed: true, resetAt: 1000 })
  expect(await store.hit('ip:/api/a', 1000, 1, 10)).toEqual({ allowed: false, resetAt: 1000 })
  expect((await store.hit('ip:/api/b', 1000, 1, 10)).allowed).toBe(true)
  expect(await store.hit('ip:/api/a', 1000, 1, 1000)).toEqual({ allowed: true, resetAt: 2000 })
})
```

- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
// src/workers/rate-limiter.ts — one Durable Object per client+path key. Its
// memory is the window; a reset after eviction only forgives a few requests.
import type { RateLimitStore } from '../platform'
import type { DurableObjectNamespaceLike, DurableObjectStateLike } from './types'

import { createMemoryRateLimitStore } from '../platform'
import { stub } from './types'

type HitRequest = { windowMs: number; max: number; now: number }

export class RateLimiter {
  private readonly store = createMemoryRateLimitStore()

  constructor(_state: DurableObjectStateLike, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const { windowMs, max, now } = (await request.json()) as HitRequest
    return Response.json(await this.store.hit('window', windowMs, max, now))
  }
}

export function durableRateLimitStore(namespace: DurableObjectNamespaceLike): RateLimitStore {
  return {
    async hit(key, windowMs, max, now = Date.now()) {
      const res = await stub(namespace, key).fetch('https://rate-limiter/hit', {
        method: 'POST',
        body: JSON.stringify({ windowMs, max, now } satisfies HitRequest),
      })
      return res.json()
    },
  }
}
```

- [ ] **Step 4:** Test and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workers): RateLimiter Durable Object`.

---

### Task 4: `RealtimeHub` Durable Object and `HubPublisher`

**Files:**
- Create: `packages/bunderstack/src/workers/realtime-hub.ts`
- Test: `packages/bunderstack/src/workers/realtime-hub.test.ts`

**Interfaces:**
- Consumes: `RealtimeEvents`, `RealtimePublisher` from `../realtime/publisher`; `MemoryPublisher` from `@orpc/publisher/memory`; `Publisher` from `@orpc/publisher`; `getEventMeta`, `withEventMeta` from `@orpc/server`.
- Produces:
  - `class RealtimeHub { heartbeatMs: number; constructor(state, env); fetch(request): Promise<Response> }` — `POST /publish` body `{ event, payload }` → 204; `GET /subscribe?event=&lastEventId=` → NDJSON stream of `{ type: 'event', id, payload }` and `{ type: 'heartbeat' }` lines.
  - `class HubPublisher extends Publisher<RealtimeEvents>` — `constructor(hub: () => FetcherLike, options?: PublisherOptions)`. Events that it delivers carry the hub id as event meta `id`.

- [ ] **Step 1: Failing tests.**

```ts
import { getEventMeta } from '@orpc/server'
import { expect, test } from 'bun:test'

import type { RealtimeChange } from '../realtime/publisher'

import { createFakeNamespace } from '../testing/workers-fakes'
import { HubPublisher, RealtimeHub } from './realtime-hub'
import { stub } from './types'

function setup(heartbeatMs = 20_000) {
  const namespace = createFakeNamespace((state) => {
    const hub = new RealtimeHub(state, {})
    hub.heartbeatMs = heartbeatMs
    return hub
  })
  return { namespace, publisher: () => new HubPublisher(() => stub(namespace, 'main')) }
}

const change = (id: string): RealtimeChange => ({ table: 'notes', action: 'create', record: { id } })

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
  expect(check()).toBe(true)
}

test('a publish from one publisher reaches a subscriber of another', async () => {
  const { publisher } = setup()
  const reader = publisher()
  const writer = publisher()
  const seen: RealtimeChange[] = []
  const unsubscribe = await reader.subscribe('change', (event) => void seen.push(event))
  await writer.publish('change', change('n1'))
  await until(() => seen.length === 1)
  expect(seen[0]!.record).toEqual({ id: 'n1' })
  expect(getEventMeta(seen[0]!)?.id).toBeString()
  await unsubscribe()
})

test('a subscriber resumes after lastEventId', async () => {
  const { publisher } = setup()
  const p = publisher()
  const first: RealtimeChange[] = []
  const stop = await p.subscribe('change', (event) => void first.push(event))
  await p.publish('change', change('a'))
  await p.publish('change', change('b'))
  await until(() => first.length === 2)
  await stop()
  const lastEventId = getEventMeta(first[0]!)!.id
  const resumed: RealtimeChange[] = []
  const stop2 = await p.subscribe('change', (event) => void resumed.push(event), { lastEventId })
  await until(() => resumed.length === 1)
  expect(resumed[0]!.record).toEqual({ id: 'b' })
  await stop2()
})

test('the hub stream sends heartbeats', async () => {
  const { namespace } = setup(5)
  const res = await stub(namespace, 'main').fetch('https://hub/subscribe?event=change')
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  const { value } = await reader.read()
  expect(value).toContain('"type":"heartbeat"')
  await reader.cancel()
})
```

- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement `src/workers/realtime-hub.ts`.**

```ts
// src/workers/realtime-hub.ts — realtime fan-out for one app. The hub holds a
// MemoryPublisher with resume; Workers reach it over a line-delimited stream.
import type { PublisherOptions, PublisherSubscribeListenerOptions } from '@orpc/publisher'

import { Publisher } from '@orpc/publisher'
import { MemoryPublisher } from '@orpc/publisher/memory'
import { getEventMeta, withEventMeta } from '@orpc/server'

import type { RealtimeEvents } from '../realtime/publisher'
import type { DurableObjectStateLike, FetcherLike } from './types'

type HubLine =
  | { type: 'event'; id?: string; payload: object }
  | { type: 'heartbeat' }

export class RealtimeHub {
  /** celld closes a stream after 60 s of silence. */
  heartbeatMs = 20_000
  private readonly publisher = new MemoryPublisher<Record<string, object>>({
    resume: { enabled: true, seconds: 300 },
  })

  constructor(_state: DurableObjectStateLike, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/publish' && request.method === 'POST') {
      const { event, payload } = (await request.json()) as { event: string; payload: object }
      await this.publisher.publish(event, payload)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/subscribe') return this.subscribe(url, request.signal)
    return new Response('Not found', { status: 404 })
  }

  private async subscribe(url: URL, signal: AbortSignal): Promise<Response> {
    const event = url.searchParams.get('event') ?? 'change'
    const lastEventId = url.searchParams.get('lastEventId') ?? undefined
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    let closed = false
    let timer: ReturnType<typeof setInterval> | undefined
    let unsubscribe: (() => Promise<void>) | undefined
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      void unsubscribe?.()
      void writer.close().catch(() => {})
    }
    const write = (line: HubLine) => {
      if (closed) return
      writer.write(encoder.encode(`${JSON.stringify(line)}\n`)).catch(close)
    }
    unsubscribe = await this.publisher.subscribe(
      event,
      (payload) => write({ type: 'event', id: getEventMeta(payload)?.id, payload }),
      { lastEventId },
    )
    timer = setInterval(() => write({ type: 'heartbeat' }), this.heartbeatMs)
    signal?.addEventListener('abort', close)
    return new Response(readable, { headers: { 'content-type': 'application/x-ndjson' } })
  }
}

export class HubPublisher extends Publisher<RealtimeEvents> {
  constructor(
    private readonly hub: () => FetcherLike,
    options?: PublisherOptions,
  ) {
    super(options)
  }

  async publish<K extends keyof RealtimeEvents & string>(event: K, payload: RealtimeEvents[K]) {
    const res = await this.hub().fetch('https://hub/publish', {
      method: 'POST',
      body: JSON.stringify({ event, payload }),
    })
    if (!res.ok) throw new Error(`[bunderstack] realtime hub publish failed (${res.status})`)
  }

  protected async subscribeListener<K extends keyof RealtimeEvents & string>(
    event: K,
    listener: (payload: RealtimeEvents[K]) => void,
    options?: PublisherSubscribeListenerOptions,
  ): Promise<() => Promise<void>> {
    const url = new URL('https://hub/subscribe')
    url.searchParams.set('event', event)
    if (options?.lastEventId) url.searchParams.set('lastEventId', options.lastEventId)
    const controller = new AbortController()
    const res = await this.hub().fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      throw new Error(`[bunderstack] realtime hub subscribe failed (${res.status})`)
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    void (async () => {
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += value
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const text = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (!text) continue
            const line = JSON.parse(text) as HubLine
            if (line.type !== 'event') continue
            const payload = line.payload as RealtimeEvents[K]
            listener(line.id ? withEventMeta(payload, { id: line.id }) : payload)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) options?.onError?.(error as Error)
      }
    })()
    return async () => {
      controller.abort()
      await reader.cancel().catch(() => {})
    }
  }
}
```

If `import type { PublisherOptions, PublisherSubscribeListenerOptions } from '@orpc/publisher'` or the protected-method signature does not type-check, copy the exact generic signature from `node_modules/.bun/@orpc+publisher@2.0.0-beta.37/node_modules/@orpc/publisher/dist/index.d.mts`.

- [ ] **Step 4:** Test and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workers): RealtimeHub Durable Object and HubPublisher`.

---

### Task 5: Worker app cache, platform from bindings, and `Scheduler`

**Files:**
- Create: `packages/bunderstack/src/workers/app.ts`
- Create: `packages/bunderstack/src/workers/scheduler.ts`
- Test: `packages/bunderstack/src/workers/scheduler.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4, `BunderstackBackend` from `../backend`, `Platform` from `../platform`.
- Produces:
  - `app.ts`: `type WorkerApp = { handler(req: Request): Promise<Response>; jobs: { tick(now?: number): Promise<{ claimed: number }>; nextDueAt(now?: number, until?: number): Promise<number | null> } }`; `workerPlatform(env: WorkerEnv): Partial<Platform>`; `appFor(backend, env, role: 'fetch' | 'scheduler', platform?: Partial<Platform>): Promise<WorkerApp>` (cached per backend and role; a failed start clears the cache); `envStrings(env): Record<string, string>`; `notifyScheduler(namespace, runAt): Promise<void>`.
  - `scheduler.ts`: `createSchedulerClass(backend)` returns a class with `fetch(request)` (`POST /notify` body `{ runAt }`) and `alarm()`. Constants: `TICK_BUDGET_MS = 25_000`, `NOTIFY_RETRY_MS = 1_000`, `SAFETY_MS = 3_600_000`, `MIN_GAP_MS = 1_000`.

- [ ] **Step 1: Write `app.ts`.**

```ts
// src/workers/app.ts — one app per isolate and role, built from bindings.
import type { BunderstackBackend } from '../backend'
import type { Platform } from '../platform'
import type { DurableObjectNamespaceLike, WorkerEnv } from './types'

import { durableRateLimitStore } from './rate-limiter'
import { HubPublisher } from './realtime-hub'
import { workerStorageFactory } from './r2'
import { stub } from './types'

export type WorkerApp = {
  handler(request: Request): Promise<Response>
  jobs: {
    tick(now?: number): Promise<{ claimed: number }>
    nextDueAt(now?: number, until?: number): Promise<number | null>
  }
}

export async function notifyScheduler(namespace: DurableObjectNamespaceLike, runAt: number) {
  const res = await stub(namespace, 'main').fetch('https://scheduler/notify', {
    method: 'POST',
    body: JSON.stringify({ runAt }),
  })
  if (!res.ok) throw new Error(`[bunderstack] scheduler notify failed (${res.status})`)
}

export function envStrings(env: WorkerEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export function workerPlatform(env: WorkerEnv): Partial<Platform> {
  const { SCHEDULER, REALTIME, RATE_LIMITER } = env
  return {
    ...(SCHEDULER ? { jobs: { notify: (runAt: number) => notifyScheduler(SCHEDULER, runAt) } } : {}),
    ...(REALTIME ? { realtime: new HubPublisher(() => stub(REALTIME, 'main')) } : {}),
    ...(RATE_LIMITER ? { rateLimit: durableRateLimitStore(RATE_LIMITER) } : {}),
    storage: workerStorageFactory(env),
  }
}

type AnyBackend = BunderstackBackend<any>
const apps = new WeakMap<AnyBackend, Map<string, Promise<WorkerApp>>>()

export function appFor(
  backend: AnyBackend,
  env: WorkerEnv,
  role: 'fetch' | 'scheduler',
  platform: Partial<Platform> = {},
): Promise<WorkerApp> {
  let byRole = apps.get(backend)
  if (!byRole) apps.set(backend, (byRole = new Map()))
  const cached = byRole.get(role)
  if (cached) return cached
  const started = backend.start({
    env: envStrings(env),
    platform: { ...workerPlatform(env), ...platform },
  }) as Promise<WorkerApp>
  byRole.set(role, started)
  // A failed start must not poison the isolate: the next request retries.
  started.catch(() => byRole.delete(role))
  return started
}
```

- [ ] **Step 2: Failing tests** in `src/workers/scheduler.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { provision } from '../provision-schema'
import { createFakeNamespace } from '../testing/workers-fakes'
import { appFor } from './app'
import { createSchedulerClass } from './scheduler'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

async function setup() {
  // A file database: the Worker app and the scheduler app are two clients.
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-scheduler-'))
  const ran: string[] = []
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    jobs: (j) =>
      j.define({
        work: j.job({ handler: async () => void ran.push('work') }),
        beat: j.cron({ schedule: '0 0 1 1 *', handler: async () => void ran.push('beat') }),
      }),
  })
  const Scheduler = createSchedulerClass(backend)
  const SCHEDULER = createFakeNamespace((state) => new Scheduler(state, env))
  const env = { DATABASE_URL: `file:${join(dir, 'db.sqlite')}`, SCHEDULER }
  const app = await appFor(backend, env, 'fetch')
  await provision(app as never, { force: true })
  return {
    ran,
    app: app as unknown as { jobs: { enqueue(n: string, i?: unknown, o?: object): Promise<unknown> } },
    scheduler: () => SCHEDULER.instance('main') as InstanceType<typeof Scheduler>,
    alarmAt: () => SCHEDULER.state('main').alarmAt(),
    fire: async () => {
      await SCHEDULER.state('main').storage.deleteAlarm()
      await SCHEDULER.instance('main').alarm()
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test('enqueue notifies the scheduler, and its alarm runs the job', async () => {
  const s = await setup()
  try {
    const before = Date.now()
    await s.app.jobs.enqueue('work')
    expect(s.alarmAt()).toBeGreaterThanOrEqual(before)
    expect(s.alarmAt()).toBeLessThanOrEqual(Date.now())
    await s.scheduler().alarm()
    expect(s.ran).toEqual(['work'])
    // Next alarm: the yearly cron is beyond the safety window, so the cap.
    expect(s.alarmAt()).toBeGreaterThan(Date.now() + 3_500_000)
  } finally {
    await s.cleanup()
  }
})

test('a notify alarm that finds nothing retries once after a second', async () => {
  const s = await setup()
  try {
    await s.scheduler().fetch(
      new Request('https://scheduler/notify', {
        method: 'POST',
        body: JSON.stringify({ runAt: Date.now() }),
      }),
    )
    const before = Date.now()
    await s.scheduler().alarm()
    expect(s.alarmAt()).toBeGreaterThanOrEqual(before + 1_000)
    expect(s.alarmAt()).toBeLessThan(before + 5_000)
    // Simulate the retry alarm firing: the fake never clears it by itself.
    await s.fire()
    expect(s.alarmAt()).toBeGreaterThan(Date.now() + 3_500_000)
  } finally {
    await s.cleanup()
  }
})

test('a later notify never pushes an earlier alarm back', async () => {
  const s = await setup()
  try {
    const now = Date.now()
    const notify = (runAt: number) =>
      s.scheduler().fetch(
        new Request('https://scheduler/notify', { method: 'POST', body: JSON.stringify({ runAt }) }),
      )
    await notify(now + 10_000)
    await notify(now + 60_000)
    expect(s.alarmAt()).toBe(now + 10_000)
  } finally {
    await s.cleanup()
  }
})
```

- [ ] **Step 3:** Run — Expected: FAIL (`./scheduler` missing).
- [ ] **Step 4: Implement `src/workers/scheduler.ts`.**

```ts
// src/workers/scheduler.ts — the only place background work runs in a Worker.
// One instance per app ('main'). Its alarm chain follows app.jobs.nextDueAt;
// enqueues and Cron Triggers pull the alarm earlier through /notify.
import type { BunderstackBackend } from '../backend'
import type { DurableObjectStateLike, WorkerEnv } from './types'

import { appFor, type WorkerApp } from './app'

export const TICK_BUDGET_MS = 25_000
export const NOTIFY_RETRY_MS = 1_000
export const SAFETY_MS = 3_600_000
export const MIN_GAP_MS = 1_000

export function createSchedulerClass(backend: BunderstackBackend<any>) {
  return class Scheduler {
    private notified = false
    private retried = false

    constructor(
      private readonly state: DurableObjectStateLike,
      private readonly env: WorkerEnv,
    ) {}

    private app(): Promise<WorkerApp> {
      // Enqueues from job handlers move this alarm directly, not via a stub.
      return appFor(backend, this.env, 'scheduler', {
        jobs: { notify: (runAt) => this.schedule(runAt) },
      })
    }

    /** Only ever moves the alarm earlier. */
    private async schedule(runAt: number) {
      const current = await this.state.storage.getAlarm()
      if (current === null || runAt < current) {
        await this.state.storage.setAlarm(runAt)
      }
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname !== '/notify' || request.method !== 'POST') {
        return new Response('Not found', { status: 404 })
      }
      const { runAt } = (await request.json()) as { runAt: number }
      this.notified = true
      this.retried = false
      await this.schedule(runAt)
      return new Response(null, { status: 204 })
    }

    async alarm(): Promise<void> {
      // Clear the alarm that fired, so schedule() below can set a later one.
      const fired = await this.state.storage.getAlarm()
      if (fired !== null && fired <= Date.now()) {
        await this.state.storage.deleteAlarm()
      }
      const app = await this.app()
      const started = Date.now()
      let claimed = 0
      for (;;) {
        const result = await app.jobs.tick(Date.now())
        claimed += result.claimed
        if (result.claimed === 0 || Date.now() - started > TICK_BUDGET_MS) break
      }
      const now = Date.now()
      // An enqueue inside a transaction notifies before its commit.
      if (this.notified && claimed === 0 && !this.retried) {
        this.retried = true
        await this.schedule(now + NOTIFY_RETRY_MS)
        return
      }
      this.notified = false
      const next = await app.jobs.nextDueAt(now, now + SAFETY_MS)
      await this.schedule(Math.max(next ?? now + SAFETY_MS, now + MIN_GAP_MS))
    }
  }
}
```

Note: on Cloudflare the fired alarm is already cleared when `alarm()` runs; the first lines make the fake and celld behave the same. A `/notify` that arrives during the run still wins, because `schedule()` keeps the earlier time.

- [ ] **Step 5:** Test and typecheck — Expected: PASS.
- [ ] **Step 6: Commit** `feat(workers): Scheduler Durable Object and the Worker app cache`.

---

### Task 6: `createWorker` and the `bunderstack/workers` export

**Files:**
- Create: `packages/bunderstack/src/workers/index.ts`
- Test: `packages/bunderstack/src/workers/index.test.ts`
- Modify: `packages/bunderstack/package.json` (`exports["./workers"]`)
- Modify: `docs/superpowers/specs/2026-09-27-workers-runtime-design.md` (the app entry snippet; Cron Triggers)

**Interfaces:**
- Produces:

```ts
export function createWorker(backend: BunderstackBackend<any>): {
  handler: {
    fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response>
    scheduled(controller: unknown, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void>
  }
  durableObjects: {
    Scheduler: ReturnType<typeof createSchedulerClass>
    RealtimeHub: typeof RealtimeHub
    RateLimiter: typeof RateLimiter
  }
}
```

  and re-exports: `RealtimeHub`, `RateLimiter`, `HubPublisher`, `R2StorageAdapter`, `bucketBindingName`, `createSchedulerClass`, and the types from `./types`.

- Behavior: `fetch` answers through `app.handler`; when the app answers 404 and `env.ASSETS` exists, it answers from `env.ASSETS` (SPA fallback when a path reaches the Worker). `scheduled` calls `ctx.waitUntil(notifyScheduler(env.SCHEDULER, Date.now()))` when `SCHEDULER` exists.

App entry (for the spec and the examples):

```ts
// src/worker.ts
import { createWorker } from 'bunderstack/workers'

import { backend } from './bunderstack'

const worker = createWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
```

- [ ] **Step 1: Failing tests** in `src/workers/index.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { createFakeNamespace } from '../testing/workers-fakes'
import { createWorker } from './index'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })
const ctx = () => {
  const pending: Promise<unknown>[] = []
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), pending }
}

function backendWithJobs() {
  return bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    jobs: (j) => j.define({ beat: j.cron({ schedule: '* * * * *', handler: async () => {} }) }),
  })
}

test('fetch serves the API and falls back to assets on 404', async () => {
  const worker = createWorker(backendWithJobs())
  const env = {
    DATABASE_URL: ':memory:',
    ASSETS: { fetch: async () => new Response('<html>spa</html>') },
  }
  const health = await worker.handler.fetch(new Request('https://app.test/api/health'), env, ctx())
  expect(health.status).toBe(200)
  const page = await worker.handler.fetch(new Request('https://app.test/boards/1'), env, ctx())
  expect(await page.text()).toBe('<html>spa</html>')
})

test('a failed start is retried by the next request', async () => {
  const worker = createWorker(
    bunderstack({ schema: { notes }, database: { adapter: libsql() }, env: { server: { NEEDED: undefined as never } } } as never),
  )
  await expect(
    worker.handler.fetch(new Request('https://app.test/api/health'), {}, ctx()),
  ).rejects.toThrow()
  await expect(
    worker.handler.fetch(new Request('https://app.test/api/health'), {}, ctx()),
  ).rejects.toThrow()
})

test('scheduled wakes the Scheduler', async () => {
  const backend = backendWithJobs()
  const worker = createWorker(backend)
  const SCHEDULER = createFakeNamespace((state) => new worker.durableObjects.Scheduler(state, env))
  const env = { DATABASE_URL: ':memory:', SCHEDULER }
  const c = ctx()
  const before = Date.now()
  await worker.handler.scheduled({}, env, c)
  await Promise.all(c.pending)
  expect(SCHEDULER.state('main').alarmAt()).toBeGreaterThanOrEqual(before)
})
```

(For the second test: any definition whose `start()` throws is enough. If the `env.server` trick does not throw, use `import * as v from 'valibot'` and `env: { server: { NEEDED: v.string() } }`. The point is that the second call throws again instead of hanging on a cached rejected promise, and that it throws from a new `start()`: count calls with a wrapper `{ ...backend, start: (o) => { calls++; return backend.start(o) } }` and expect `calls` to be 2.)

- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement `src/workers/index.ts`.**

```ts
// src/workers/index.ts — `bunderstack/workers`: run an app as a Worker on
// Cloudflare or celld. See the Workers runtime spec for the binding names.
import type { BunderstackBackend } from '../backend'
import type { ExecutionContextLike, WorkerEnv } from './types'

import { appFor, notifyScheduler } from './app'
import { RateLimiter } from './rate-limiter'
import { RealtimeHub } from './realtime-hub'
import { createSchedulerClass } from './scheduler'

export function createWorker(backend: BunderstackBackend<any>) {
  const handler = {
    async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContextLike) {
      const app = await appFor(backend, env, 'fetch')
      const response = await app.handler(request)
      if (response.status === 404 && env.ASSETS) return env.ASSETS.fetch(request)
      return response
    },
    async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContextLike) {
      if (env.SCHEDULER) ctx.waitUntil(notifyScheduler(env.SCHEDULER, Date.now()))
    },
  }
  return {
    handler,
    durableObjects: {
      Scheduler: createSchedulerClass(backend),
      RealtimeHub,
      RateLimiter,
    },
  }
}

export { createSchedulerClass } from './scheduler'
export { HubPublisher, RealtimeHub } from './realtime-hub'
export { durableRateLimitStore, RateLimiter } from './rate-limiter'
export { bucketBindingName, R2StorageAdapter } from './r2'
export type * from './types'
```

In `package.json` `exports`, after `"./testing"`, add:

```json
    "./workers": {
      "types": "./dist/workers/index.d.ts",
      "default": "./dist/workers/index.js"
    },
```

- [ ] **Step 4: Update the spec.** In `docs/superpowers/specs/2026-09-27-workers-runtime-design.md`, replace the `// src/worker.ts` snippet with the one above and the sentence "Durable Object classes that the app re-exports" with: "`createWorker(backend)` returns `{ handler, durableObjects }`. The `Scheduler` needs the backend, so the classes come from this call, and the app exports them by name." Under `### Jobs: Scheduler`, add: "`wrangler.json` has `triggers.crons` with the declared cron schedules (and the storage sweep when there are buckets). The `scheduled` handler notifies the `Scheduler`, so cron runs even when the app gets no traffic. More than five schedules collapse to `* * * * *`. The safety cap is 1 hour, not 5 minutes."
- [ ] **Step 5:** `bun test src/workers`, `bun run typecheck`, `bun run build` (expected: `dist/workers/index.js` exists), and from the repo root `bun test scripts/dependency-boundaries.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(workers): createWorker and the bunderstack/workers export`.

---

### Task 7: `wrangler.json` generation and `bunderstack wrangler`

**Files:**
- Create: `packages/bunderstack/src/workers/wrangler.ts`
- Test: `packages/bunderstack/src/workers/wrangler.test.ts`
- Modify: `packages/bunderstack/src/cli.ts` (help text and a `wrangler` branch)

**Interfaces:**
- Produces:
  - `buildWranglerConfig(manifest: BunderstackManifest, options: { name: string; compatibilityDate: string; main?: string; assetsDirectory?: string }): WranglerConfig` (plain JSON object; defaults `main: 'src/worker.ts'`, `assetsDirectory: 'dist/client'`).
  - `runWranglerCommand(options: { directory: string; entry?: string; name?: string; assets?: string; output?: string; check?: boolean }): Promise<{ path: string; changed: boolean }>` — throws `WranglerCheckError` on `--check` drift.

- [ ] **Step 1: Failing tests.**

```ts
import { expect, test } from 'bun:test'

import type { BunderstackManifest } from '../manifest'

import { buildWranglerConfig } from './wrangler'

function manifest(overrides: Partial<BunderstackManifest> = {}): BunderstackManifest {
  return {
    version: 4,
    database: { dialect: 'sqlite', migrationsDirectory: './migrations', tables: [] },
    storage: { defaultBucket: 'media', buckets: [{ name: 'media', visibility: 'private' }] },
    realtime: { required: true },
    messaging: { channels: [] },
    environment: [],
    api: { operations: [{ handle: 'hook', operationId: 'hook', effect: 'mutation', method: 'POST', path: '/webhooks/stripe' } as never] },
    background: {
      jobs: [{ name: 'work' }],
      cron: [{ name: 'digest', schedule: '0 8 * * *', timezone: 'UTC' }],
      maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' }],
    },
    ...overrides,
  }
}

test('the config has the DO bindings, R2 buckets, assets, and cron triggers', () => {
  const config = buildWranglerConfig(manifest(), { name: 'fikflix', compatibilityDate: '2026-09-28' })
  expect(config).toEqual({
    name: 'fikflix',
    main: 'src/worker.ts',
    compatibility_date: '2026-09-28',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: {
      bindings: [
        { name: 'SCHEDULER', class_name: 'Scheduler' },
        { name: 'REALTIME', class_name: 'RealtimeHub' },
        { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Scheduler', 'RealtimeHub', 'RateLimiter'] }],
    r2_buckets: [{ binding: 'BUCKET_MEDIA', bucket_name: 'fikflix-media' }],
    assets: {
      directory: 'dist/client',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*', '/webhooks/*'],
    },
    triggers: { crons: ['0 4 * * *', '0 8 * * *'] },
  })
})

test('no storage means no sweep trigger and no R2; many crons collapse', () => {
  const crons = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, schedule: `${i} * * * *`, timezone: 'UTC' as const }))
  const config = buildWranglerConfig(
    manifest({
      storage: { defaultBucket: '', buckets: [] },
      background: { jobs: [], cron: crons, maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' }] },
    }),
    { name: 'app', compatibilityDate: '2026-09-28' },
  )
  expect(config.r2_buckets).toEqual([])
  expect(config.triggers).toEqual({ crons: ['* * * * *'] })
})

test('no cron and no storage means no triggers key', () => {
  const config = buildWranglerConfig(
    manifest({
      storage: { defaultBucket: '', buckets: [] },
      background: { jobs: [], cron: [], maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' }] },
    }),
    { name: 'app', compatibilityDate: '2026-09-28' },
  )
  expect('triggers' in config).toBe(false)
})
```

If the `ApiOperation` type needs more fields, fill them from `src/manifest.ts`; only `path` matters here.

- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement `src/workers/wrangler.ts`.**

```ts
// src/workers/wrangler.ts — wrangler.json from the backend manifest. The same
// file deploys with `wrangler deploy` (Cloudflare) and `celld deploy`.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { BunderstackManifest } from '../manifest'

import { isBunderstackBackend } from '../backend'
import { bucketBindingName } from './r2'

/** Cloudflare's per-Worker Cron Trigger limit on the free plan. */
const MAX_CRONS = 5

export type WranglerConfig = ReturnType<typeof buildWranglerConfig>

export function buildWranglerConfig(
  manifest: BunderstackManifest,
  options: { name: string; compatibilityDate: string; main?: string; assetsDirectory?: string },
) {
  const hasStorage = manifest.storage.buckets.length > 0
  const crons = [
    ...new Set([
      ...manifest.background.cron.map((cron) => cron.schedule),
      ...(hasStorage ? manifest.background.maintenance.map((m) => m.schedule) : []),
    ]),
  ].sort()
  const prefixes = [
    ...new Set([
      '/api/*',
      ...manifest.api.operations.map((op) => `/${op.path.split('/')[1]}/*`),
    ]),
  ]
  return {
    name: options.name,
    main: options.main ?? 'src/worker.ts',
    compatibility_date: options.compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    durable_objects: {
      bindings: [
        { name: 'SCHEDULER', class_name: 'Scheduler' },
        { name: 'REALTIME', class_name: 'RealtimeHub' },
        { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Scheduler', 'RealtimeHub', 'RateLimiter'] }],
    r2_buckets: manifest.storage.buckets.map((bucket) => ({
      binding: bucketBindingName(bucket.name),
      bucket_name: `${options.name}-${bucket.name}`,
    })),
    assets: {
      directory: options.assetsDirectory ?? 'dist/client',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: prefixes,
    },
    ...(crons.length > 0
      ? { triggers: { crons: crons.length > MAX_CRONS ? ['* * * * *'] : crons } }
      : {}),
  }
}

export class WranglerCheckError extends Error {
  constructor(path: string) {
    super(`[bunderstack] ${path} is out of date; run \`bunderstack wrangler\``)
    this.name = 'WranglerCheckError'
  }
}

export async function runWranglerCommand(options: {
  directory: string
  entry?: string
  name?: string
  assets?: string
  output?: string
  check?: boolean
}): Promise<{ path: string; changed: boolean }> {
  const directory = resolve(options.directory)
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    name?: string
    bunderstack?: { entry?: string }
  }
  const entry = options.entry ?? pkg.bunderstack?.entry ?? 'src/bunderstack.ts'
  const module = (await import(pathToFileURL(join(directory, entry)).href)) as { backend?: unknown }
  if (!isBunderstackBackend(module.backend)) {
    throw new Error(`[bunderstack] ${entry} must export backend`)
  }
  const path = join(directory, options.output ?? 'wrangler.json')
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  const previous = existing ? (JSON.parse(existing) as { compatibility_date?: string }) : undefined
  const name = (options.name ?? pkg.name ?? 'app').replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/g, '-')
  const config = buildWranglerConfig(module.backend.inspect({ env: process.env }), {
    name,
    // Keep the date once chosen, so --check stays stable across days.
    compatibilityDate: previous?.compatibility_date ?? new Date().toISOString().slice(0, 10),
    assetsDirectory: options.assets,
  })
  const text = `${JSON.stringify(config, null, 2)}\n`
  if (options.check) {
    if (existing !== text) throw new WranglerCheckError(path)
    return { path, changed: false }
  }
  if (existing === text) return { path, changed: false }
  await writeFile(path, text)
  return { path, changed: true }
}
```

In `src/cli.ts`, add to `help`: `  bunderstack wrangler [directory] [--entry <path>] [--name <name>] [--assets <dir>] [--output <path>] [--check]` and a line `wrangler   Generate wrangler.json for Cloudflare and celld from the backend.`. Before `if (args[0] !== 'blueprint')`, add a branch that parses these flags the same way the `blueprint` branch does, calls `runWranglerCommand` (dynamic `await import('./workers/wrangler')` with a string literal), prints `wrangler.json is current` or `Generated wrangler.json`, and returns 1 on error.

- [ ] **Step 4:** `bun test src/workers/wrangler.test.ts src/cli.test.ts`, `bun run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workers): generate wrangler.json with bunderstack wrangler`.

---

### Task 8: Integration run on celld and workerd

**Files:**
- Create: `examples/workers-probe/package.json`, `examples/workers-probe/src/schema.ts`, `examples/workers-probe/src/bunderstack.ts`, `examples/workers-probe/src/worker.ts`, `examples/workers-probe/public/index.html`, `examples/workers-probe/wrangler.json` (generated)
- Create: `scripts/workers-integration.ts`
- Modify: root `package.json` (script `"test:workers": "bun scripts/workers-integration.ts"`, devDependency `esbuild`)

**Interfaces:**
- Consumes: everything above. Binaries: `CELLD_BIN` (default `celld` on `PATH`), `SQLD_BIN` (default `sqld`), `CELLD_ESBUILD` (default the repo `node_modules/.bin/esbuild`). Runtime selection: `--runtime celld|workerd` (default `celld`). workerd runs through `bunx wrangler@4 dev`.

- [ ] **Step 1: The probe app.** `examples/workers-probe/package.json`:

```json
{
  "name": "workers-probe",
  "private": true,
  "type": "module",
  "scripts": { "wrangler": "bun ../../packages/bunderstack/src/cli.ts wrangler . --assets public" },
  "dependencies": {
    "@libsql/client": "^0.14.0",
    "@orpc/server": "2.0.0-beta.37",
    "better-auth": "^1.7.6",
    "bunderstack": "workspace:*",
    "drizzle-orm": "^0.45.0",
    "valibot": "1.4.2"
  }
}
```

`src/schema.ts`: copy the four auth tables from `templates/tanstack-start-saas/src/bunderstack/schema/auth.ts`, then add `notes` (`id` typeid `note`, `title`, `createdAt`) and `events` (`id` typeid `event`, `kind`, `detail`, `at`), exactly as in the spike (`celld-spike/app/src/schema.ts` in the session scratchpad; the columns are listed in the spec's spike section).

`src/bunderstack.ts`:

```ts
import { bunderstack } from 'bunderstack'
import { defineAccess } from 'bunderstack/access'
import { libsql } from 'bunderstack/libsql'
import * as v from 'valibot'

import * as schema from './schema'

export const backend = bunderstack({
  schema,
  access: defineAccess(schema, {
    notes: { crud: true, list: 'authenticated', get: 'authenticated', create: 'authenticated', update: 'authenticated', delete: 'authenticated' },
    events: { crud: true, list: 'public', get: 'public', create: 'deny', update: 'deny', delete: 'deny' },
  }),
  database: { adapter: libsql() },
  auth: ({ env }) => ({
    baseURL: env.APP_URL,
    emailAndPassword: { enabled: true },
    advanced: { database: { generateId: () => false } },
  }),
  env: { server: { APP_URL: v.optional(v.string(), 'http://127.0.0.1:8787') } },
  storage: { local: true, defaultBucket: 'media', buckets: { media: { upload: { maxSize: '1mb' } } } },
  realtime: true,
  rateLimit: { windowMs: 60_000, max: 1_000 },
  jobs: (j) =>
    j.define({
      noteCreated: j.job({
        input: v.object({ noteId: v.string() }),
        handler: async (input, ctx) => {
          await ctx.db.insert(schema.events).values({ kind: 'job', detail: input.noteId })
        },
      }),
      everyMinute: j.cron({
        schedule: '* * * * *',
        handler: async ({ scheduledFor }, ctx) => {
          await ctx.db.insert(schema.events).values({ kind: 'cron', detail: scheduledFor.toISOString() })
        },
      }),
    }),
  api: (o) => ({
    enqueueNote: o.public
      .route({ method: 'POST', path: '/api/probe/enqueue' })
      .handler(async ({ input, context }) => {
        const noteId = (input as { noteId?: string } | undefined)?.noteId ?? 'none'
        return context.jobs.enqueue('noteCreated', { noteId })
      }),
  }),
})
```

(If `o.public.route(...).handler(...)` without `.input(...)` does not type-check, add `.input(v.object({ noteId: v.string() }))` and read `input.noteId`.)

`src/worker.ts`: the app entry from Task 6. `public/index.html`: `<!doctype html><title>probe</title><p>probe</p>`. Run `bun install` at the repo root, then `bun run wrangler` inside `examples/workers-probe` to generate `wrangler.json`.

- [ ] **Step 2: The script** `scripts/workers-integration.ts`. It:
  1. Runs `bun run build` in `packages/bunderstack`.
  2. Creates a temp dir, starts `sqld --http-listen-addr 127.0.0.1:<free port> -d <tmp>/db` and waits for `/health`.
  3. Provisions the probe schema under Bun: `const { backend } = await import('../examples/workers-probe/src/bunderstack.ts')`, `const app = await backend.start({ env: { BUNDERSTACK_DATABASE_URL, AUTH_SECRET } })`, `await provision(app, { force: true })` from `bunderstack/provision-schema`, `await app.close()`.
  4. Writes `examples/workers-probe/.dev.vars` with `BUNDERSTACK_DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, and deletes it at the end.
  5. Starts the runtime on a free port: celld: `CELLD_ESBUILD=<esbuild> <celld> dev examples/workers-probe --port <p> --clean --logs`; workerd: `bunx wrangler@4 dev --config examples/workers-probe/wrangler.json --port <p> --local`. Waits until `GET /api/health` answers 200 (timeout 60 s).
  6. Runs the scenarios in order, each a function that throws on failure, and prints `PASS <name>` or `FAIL <name>: <error>`:
     - `health` — 200 `{ status: 'ok' }`.
     - `static assets` — `GET /` returns the `index.html` text; `GET /some/spa/route` returns it too.
     - `auth` — sign-up, sign-in, `get-session` has the user (keep the cookie).
     - `crud` — `POST /api/notes` 201, `GET /api/notes` lists it.
     - `job via notify` — `POST /api/probe/enqueue` then poll `GET /api/events` for `{ kind: 'job' }` (timeout 10 s).
     - `sse via hub` — open `GET /api/live/notes` with the cookie, create a note from a second request, expect the note title in the stream within 10 s; keep the stream open 70 s and expect it to be still readable (heartbeats cross the 60 s celld limit).
     - `cron via alarm or trigger` — poll `GET /api/events` for `{ kind: 'cron' }` (timeout 75 s).
     - `file upload (proxy mode)` — `POST /api/files/media` multipart with a small `text/plain` file, then `GET` its URL returns the same bytes.
  7. Stops the runtime and sqld (also on failure) and exits 1 if any scenario failed.
- [ ] **Step 3: Run it.** `bun run test:workers` (celld), then `bun run test:workers -- --runtime workerd`. Expected: all scenarios PASS on both. When one fails, fix the cause in `src/workers/**` (or the core) with a unit test that reproduces it, then re-run. Record each runtime difference you find (celld vs workerd) as a short comment where the code handles it.
- [ ] **Step 4:** From the repo root: `bun run test` (exit 0), and `bun run typecheck` in `packages/bunderstack`.
- [ ] **Step 5: Changelog.** Add to the `[Unreleased]` section of both changelogs, under a new `### Added`:

```markdown
- `bunderstack/workers`: `createWorker(backend)` runs an app as a Worker on
  Cloudflare or celld, with the `Scheduler`, `RealtimeHub`, and `RateLimiter`
  Durable Objects and an R2 storage adapter.
- `bunderstack wrangler` generates `wrangler.json` from the backend, with
  Cron Triggers for the declared cron schedules.
```

- [ ] **Step 6: Commit** `test(workers): integration run on celld and workerd`.

---

## Out of scope

- `bunderstack dev` / `build` and binary downloads: stage 3. The integration script takes binaries from `PATH` or env vars.
- Examples and templates other than `workers-probe`: stage 3.
- Image transforms: stage 1b. The probe does not use `?w=`.
- Bunderhost targets: stage 5.
