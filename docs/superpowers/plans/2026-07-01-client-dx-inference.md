# Client DX: Type-Inferred Clients, Start Adapter, Scoped Collections

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer declares schema + access + config once on the server, then gets a fully typed client with `createClient<App>()` / `bunderstackStart<App>()` — no table/bucket tuples, no isomorphic-fetch boilerplate, no hand-rolled pagination collections.

**Architecture:** (1) `createBunderstack` carries schema/access/bucket types through a phantom `$inferClient` property; client packages infer exposed tables and buckets from it and materialize per-table clients lazily via Proxy. (2) A new `bunderstack-start` package owns all TanStack-Start-specific glue. (3) `bunderstack-sync`'s table collections grow `scopedCollection()` (cursor-walking growing window) and `collectionByIds()` primitives, wired into realtime. (4) Defaults cleanup: realtime off during SSR by default, `MAX_LIST_LIMIT` exported.

**Tech Stack:** Bun workspaces, TypeScript 7 RC (const type params OK), TanStack Query/DB/Start, Drizzle, BetterAuth.

## Global Constraints

- Run tests with `bun test --cwd packages/<pkg>`; typecheck with `bunx tsc --noEmit -p packages/<pkg>`.
- All packages ship raw TS from `./src/index.ts` (no build step).
- Do not break existing exports: `createBunderstackQueryClient` builder, `createBunderstackSyncClient().with()`, `createTableCollection`, `createTableClient` all keep working (other examples use them).
- Client packages must never import the Drizzle schema as a value — type-only inference.
- Server list cap is 200 (`MAX_LIST_LIMIT` in `packages/bunderstack/src/list-query.ts`); the client mirror must equal it (enforced by test).
- Commit after each task; messages in existing conventional style (`feat(scope): ...`).

---

### Task 1: `bunderstack` — type carriers on the app + `MAX_LIST_LIMIT` export

**Files:**
- Modify: `packages/bunderstack/src/list-query.ts:23`
- Modify: `packages/bunderstack/src/access.ts:358-364` (`defineAccess`)
- Modify: `packages/bunderstack/src/config.ts:59-76` (`BunderstackConfig`)
- Modify: `packages/bunderstack/src/index.ts` (`BunderstackApp`, `createBunderstack`, re-export)
- Test: `packages/bunderstack/src/infer-client.test.ts`

**Interfaces:**
- Produces: `BunderstackApp<TSchema, TAccess, TBuckets>` with optional phantom `$inferClient?: { schema: TSchema; access: TAccess; buckets: TBuckets }`; `defineAccess` returns its literal rules type; `MAX_LIST_LIMIT` exported from `bunderstack`.

- [x] **Step 1: Write the failing test** — `packages/bunderstack/src/infer-client.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'

import { createBunderstack, MAX_LIST_LIMIT } from './index'
import { defineAccess } from './access'
import { sqliteTable, text, integer } from './schema-export' // adjust to actual column-builder export

// -- type-level assertion helpers ------------------------------------------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
type Expect<T extends true> = T

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})
const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})
const schema = { user, posts }

describe('client type inference carriers', () => {
  it('exports MAX_LIST_LIMIT = 200', () => {
    expect(MAX_LIST_LIMIT).toBe(200)
  })

  it('defineAccess preserves literal rule types', () => {
    const access = defineAccess(schema, {
      user: { exposeAuthTable: true, ownerColumn: 'id' },
      posts: { ownerColumn: 'userId' },
    })
    type _1 = Expect<
      Equal<(typeof access)['user']['exposeAuthTable'], true>
    >
    expect(access.posts.ownerColumn).toBe('userId')
  })

  it('createBunderstack carries schema/access/buckets in $inferClient', () => {
    const app = createBunderstack({
      schema,
      access: {
        user: { exposeAuthTable: true, ownerColumn: 'id' },
        posts: { ownerColumn: 'userId' },
      },
      database: { url: ':memory:' },
      storage: {
        local: './uploads',
        defaultBucket: 'images',
        buckets: { images: {}, docs: {} },
      },
    })
    type Carrier = NonNullable<(typeof app)['$inferClient']>
    type _schema = Expect<Equal<Carrier['schema'], typeof schema>>
    type _buckets = Expect<Equal<Carrier['buckets'], 'images' | 'docs'>>
    type _accessUser = Expect<
      Equal<Carrier['access']['user']['exposeAuthTable'], true>
    >
    // runtime: phantom prop is never assigned
    expect('$inferClient' in app).toBe(false)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test --cwd packages/bunderstack src/infer-client.test.ts` and `bunx tsc --noEmit -p packages/bunderstack`
Expected: FAIL — `MAX_LIST_LIMIT` not exported; tsc errors on `$inferClient`.

- [x] **Step 3: Implement**

`list-query.ts:23`: `const MAX_LIST_LIMIT = 200` → `export const MAX_LIST_LIMIT = 200`.

`access.ts` — replace `defineAccess`:

```ts
export function defineAccess<
  TSchema extends Record<string, unknown>,
  const TRules extends Record<string, TableAccessInput>,
>(schema: TSchema, rules: TRules): TRules {
  validateAndResolveAccess(schema, rules)
  return rules
}
```

`config.ts` — make `BunderstackConfig` generic over access + storage (defaults keep old call sites valid):

```ts
export type BunderstackConfig<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined =
    | Record<string, TableAccessInput>
    | undefined,
  TStorage extends StorageConfigInput | undefined =
    | StorageConfigInput
    | undefined,
> = Omit<
  z.input<typeof BunderstackOptionsSchema>,
  'schema' | 'access' | 'auth' | 'storage'
> & {
  schema: TSchema
  access?: TAccess
  auth?: BetterAuthConfig
  storage?: TStorage
  rateLimit?: boolean | RateLimitConfig
  idempotency?: boolean | IdempotencyConfig
  realtime?: /* unchanged union */
}
```

`index.ts` — add bucket-name extraction, widen `BunderstackApp`, re-export the cap:

```ts
import type { StorageConfigInput } from './storage/buckets'
import type { TableAccessInput } from './access'

export { MAX_LIST_LIMIT } from './list-query'

/** Bucket names declared in a storage config; `string` when unknowable. */
export type BucketNamesOf<TStorage> = TStorage extends {
  buckets: infer B extends Record<string, unknown>
}
  ? keyof B & string
  : string

export type BunderstackApp<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = undefined,
  TBuckets extends string = string,
> = {
  /* existing members unchanged */
  /**
   * Type-only carrier for client inference (`createClient<typeof app>()`).
   * Never assigned at runtime.
   */
  readonly $inferClient?: {
    schema: TSchema
    access: TAccess
    buckets: TBuckets
  }
}

export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined = undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage>,
): BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>> {
  /* body unchanged */
}
```

- [x] **Step 4: Verify** — `bun test --cwd packages/bunderstack` (all tests) and `bunx tsc --noEmit -p packages/bunderstack`. Expected: PASS.

- [x] **Step 5: Commit** — `feat(bunderstack): carry schema/access/bucket types on the app for client inference; export MAX_LIST_LIMIT`

---

### Task 2: `bunderstack-query` — inference types + lazy `createClient<App>()`

**Files:**
- Create: `packages/bunderstack-query/src/infer.ts`
- Create: `packages/bunderstack-query/src/lazy-client.ts`
- Modify: `packages/bunderstack-query/src/table-client.ts` (add `MAX_LIST_LIMIT`)
- Modify: `packages/bunderstack-query/src/index.ts` (exports)
- Test: `packages/bunderstack-query/tests/lazy-client.test.ts`

**Interfaces:**
- Consumes: `$inferClient` phantom from Task 1.
- Produces: `createClient<TApp>(options?: { baseUrl?; fetch?; queryClient? }): BunderstackClient<TApp>`; types `AnyBunderstackApp`, `InferSchema<TApp>`, `InferTables<TApp>`, `InferBuckets<TApp>`, `ExposedTables<TSchema, TAccess>`; const `MAX_LIST_LIMIT`; runtime helper `createLazyClientProxy` (internal, reused by sync in Task 5 via its own copy of the pattern — sync builds collections, not table clients, so it implements its own proxy; only `infer.ts` types are shared).

- [x] **Step 1: Write the failing test** — `packages/bunderstack-query/tests/lazy-client.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'

import { createClient, MAX_LIST_LIMIT } from '../src/index'
import type { ExposedTables } from '../src/infer'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
type Expect<T extends true> = T

// Minimal fake app type — mirrors what createBunderstack produces.
type Row<T> = { $inferSelect: T; $inferInsert: Partial<T> }
type FakeSchema = {
  user: Row<{ id: string; name: string }>
  posts: Row<{ id: string; title: string; userId: string }>
  secrets: Row<{ id: string; key: string }>
  session: Row<{ id: string; userId: string }>
}
type FakeAccess = {
  user: { exposeAuthTable: true; ownerColumn: 'id' }
  posts: { ownerColumn: 'userId' }
  secrets: { crud: false }
}
type FakeApp = {
  $inferClient?: { schema: FakeSchema; access: FakeAccess; buckets: 'images' }
}

describe('ExposedTables', () => {
  it('derives exposure from access + convention', () => {
    type Exposed = ExposedTables<FakeSchema, FakeAccess>
    // user via exposeAuthTable, posts explicit; secrets crud:false out;
    // session is an auth table (never exposed by convention).
    type _1 = Expect<Equal<Exposed, 'user' | 'posts'>>
    expect(true).toBe(true)
  })
})

describe('createClient', () => {
  const fetchMock = (async (input: RequestInfo | URL) => {
    return new Response(
      JSON.stringify({ items: [], limit: 20, hasMore: false, url: String(input) }),
      { status: 200 },
    )
  }) as unknown as typeof fetch

  it('materializes table clients lazily and caches them', async () => {
    const api = createClient<FakeApp>({ fetch: fetchMock })
    const first = api.posts
    expect(typeof first.list).toBe('function')
    expect(api.posts).toBe(first) // stable identity
    const page = await api.posts.list()
    expect(page.items).toEqual([])
  })

  it('materializes bucket clients under files.*', () => {
    const api = createClient<FakeApp>({ fetch: fetchMock })
    expect(typeof api.files.images.upload).toBe('function')
    expect(api.files.images).toBe(api.files.images)
  })

  it('is safe against thenable/symbol probing', () => {
    const api = createClient<FakeApp>({ fetch: fetchMock })
    expect((api as Record<string, unknown>).then).toBeUndefined()
    expect((api as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined()
  })

  it('mirrors the server list cap', async () => {
    const { MAX_LIST_LIMIT: serverCap } = await import(
      'bunderstack/list-query' as string
    ).catch(() => import('bunderstack'))
    expect(MAX_LIST_LIMIT).toBe(200)
    expect(serverCap ?? 200).toBe(MAX_LIST_LIMIT)
  })
})
```

(If `bunderstack/list-query` is not an export path, import `MAX_LIST_LIMIT` from `bunderstack` directly — Task 1 re-exports it.)

- [x] **Step 2: Run to verify failure** — `bun test --cwd packages/bunderstack-query tests/lazy-client.test.ts`. Expected: FAIL (`createClient` not exported).

- [x] **Step 3: Implement**

`src/infer.ts`:

```ts
import type { AuthTableName, CrudTableKey, InferSelect } from './types'

/** Shape of the `$inferClient` phantom `createBunderstack` puts on the app. */
export type ClientCarrier = {
  schema: Record<string, unknown>
  access: unknown
  buckets: string
}

export type AnyBunderstackApp = { $inferClient?: ClientCarrier | undefined }

export type InferCarrier<TApp extends AnyBunderstackApp> = NonNullable<
  TApp['$inferClient']
>
export type InferSchema<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['schema']
export type InferBuckets<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['buckets']

type DisabledKeys<TAccess> = {
  [K in keyof TAccess & string]: TAccess[K] extends { crud: false } ? K : never
}[keyof TAccess & string]

/** Tables with an explicit access entry (auth tables need exposeAuthTable). */
type ExplicitKeys<TSchema, TAccess> = {
  [K in keyof TAccess & keyof TSchema & string]: TAccess[K] extends {
    crud: false
  }
    ? never
    : K extends AuthTableName
      ? TAccess[K] extends { exposeAuthTable: true }
        ? K extends 'user'
          ? K
          : never
        : never
      : K
}[keyof TAccess & keyof TSchema & string]

/** Tables with a `userId` column get convention CRUD without an access entry. */
type ConventionKeys<TSchema> = {
  [K in keyof TSchema & string]: K extends AuthTableName
    ? never
    : InferSelect<TSchema[K]> extends { userId: unknown }
      ? K
      : never
}[keyof TSchema & string]

/**
 * Type-level mirror of validateAndResolveAccess's exposure rules. Slightly
 * permissive on edge cases (a wrongly-included table 404s at runtime, same
 * as today's hand-written tuples — never silently narrower).
 */
export type ExposedTables<TSchema extends Record<string, unknown>, TAccess> = [
  TAccess,
] extends [undefined]
  ? CrudTableKey<TSchema>
  :
      | ExplicitKeys<TSchema, TAccess>
      | Exclude<
          ConventionKeys<TSchema>,
          DisabledKeys<TAccess> | (keyof TAccess & string)
        >

export type InferTables<TApp extends AnyBunderstackApp> = ExposedTables<
  InferSchema<TApp>,
  InferCarrier<TApp>['access']
> &
  keyof InferSchema<TApp> &
  string
```

`src/table-client.ts` — add near the top:

```ts
/**
 * Server-side cap on any single list request — mirrors MAX_LIST_LIMIT in
 * packages/bunderstack/src/list-query.ts (parity enforced by test).
 */
export const MAX_LIST_LIMIT = 200
```

`src/lazy-client.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query'

import type {
  AnyBunderstackApp,
  InferBuckets,
  InferSchema,
  InferTables,
} from './infer'
import type { FilesQueryClient, TableQueryOptionsForKey } from './types'

import {
  attachBucketMutationOptions,
  createBucketClient,
} from './bucket-client'
import { attachMutationOptions } from './mutation-options'
import { createTableClient } from './table-client'

export type ClientOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient?: QueryClient
}

export type BunderstackClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableQueryOptionsForKey<InferSchema<TApp>, K>
} & FilesQueryClient<InferBuckets<TApp>>

/** Props a Proxy must not lazily materialize (await/introspection probes). */
const PROXY_SKIP = new Set<string>(['then', 'toJSON', 'constructor', '$$typeof'])

export function lazyRecord<T>(create: (key: string) => T): Record<string, T> {
  const cache = new Map<string, T>()
  return new Proxy({} as Record<string, T>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || PROXY_SKIP.has(prop)) return undefined
      let value = cache.get(prop)
      if (value === undefined) {
        value = create(prop)
        cache.set(prop, value)
      }
      return value
    },
    has(_target, prop) {
      return typeof prop === 'string' && !PROXY_SKIP.has(prop)
    },
  })
}

/**
 * Fully typed client inferred from the server app — tables and buckets come
 * from `typeof app`, materialized lazily on first property access.
 *
 * @example
 * import type { App } from './bunderstack'   // type-only: no server code in bundle
 * const api = createClient<App>({ queryClient })
 * api.posts.list(); api.files.images.upload(file)
 */
export function createClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): BunderstackClient<TApp> {
  const baseUrl = options.baseUrl ?? '/api'
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)

  const files = lazyRecord((bucket) => {
    const bucketClient = createBucketClient({ bucket, baseUrl, fetch: fetchFn })
    return {
      ...bucketClient,
      ...attachBucketMutationOptions(bucketClient, options.queryClient),
    }
  })

  const tables = lazyRecord((tableName) => {
    const tableClient = createTableClient({ tableName, baseUrl, fetch: fetchFn })
    return {
      ...tableClient,
      ...attachMutationOptions(tableClient, options.queryClient),
    }
  })

  return new Proxy({} as BunderstackClient<TApp>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || PROXY_SKIP.has(prop)) return undefined
      if (prop === 'files') return files
      return (tables as Record<string, unknown>)[prop]
    },
    has(_target, prop) {
      return typeof prop === 'string' && !PROXY_SKIP.has(prop)
    },
  }) as BunderstackClient<TApp>
}
```

`src/index.ts` — add exports:

```ts
export { createClient, lazyRecord } from './lazy-client'
export type { BunderstackClient, ClientOptions } from './lazy-client'
export { MAX_LIST_LIMIT } from './table-client'
export type {
  AnyBunderstackApp,
  ClientCarrier,
  ExposedTables,
  InferBuckets,
  InferSchema,
  InferTables,
} from './infer'
```

- [x] **Step 4: Verify** — `bun test --cwd packages/bunderstack-query` and `bunx tsc --noEmit -p packages/bunderstack-query`. Expected: PASS.

- [x] **Step 5: Commit** — `feat(bunderstack-query): type-inferred lazy createClient<App>() and MAX_LIST_LIMIT export`

---

### Task 3: `bunderstack-query` — realtime: don't gate custom `applyEvent` on the static tables list

**Files:**
- Modify: `packages/bunderstack-query/src/realtime-client.ts:90-103`
- Test: `packages/bunderstack-query/src/realtime-client.test.ts` (extend)

**Interfaces:**
- Produces: `createRealtimeClient` calls `config.applyEvent` for events on tables NOT in `config.tables` (needed by Task 5's lazy resolver, which cannot enumerate tables upfront). `lastEventId` advances for every event.

- [x] **Step 1: Write the failing test** — append to `src/realtime-client.test.ts` (follow the file's existing SSE mock helpers; if it has a helper that feeds frames, reuse it):

```ts
it('routes events for unknown tables to a custom applyEvent', async () => {
  const seen: string[] = []
  // reuse the file's existing mock-SSE fetch harness to deliver:
  // data: {"eventId":1,"action":"create","table":"posts","record":{"id":"p1"}}
  const client = createRealtimeClient({
    baseUrl: '/api',
    queryClient: new QueryClient(),
    tables: [], // lazy client cannot enumerate tables upfront
    fetch: mockSseFetch([
      'data: {"eventId":1,"action":"create","table":"posts","record":{"id":"p1"}}\n\n',
    ]),
    applyEvent: (evt) => seen.push(evt.table),
  })
  await waitForFrames() // per existing harness
  expect(seen).toEqual(['posts'])
  client.close()
})
```

- [x] **Step 2: Run to verify failure** — `bun test --cwd packages/bunderstack-query src/realtime-client.test.ts`. Expected: FAIL (event dropped).

- [x] **Step 3: Implement** — in `apply()`, move the gate into the default path:

```ts
function apply(evt: RealtimeEvent) {
  if (typeof evt.eventId === 'number') lastEventId = evt.eventId
  if (config.applyEvent) {
    config.applyEvent(evt)
    return
  }
  const keys = keysByTable.get(evt.table)
  if (!keys) return
  const id = evt.record['id'] as string | number
  if (evt.action === 'delete')
    queryClient.removeQueries({ queryKey: keys.detail(id) })
  else queryClient.setQueryData(keys.detail(id), evt.record)
  queryClient.invalidateQueries({ queryKey: keys.lists() })
}
```

- [x] **Step 4: Verify** — `bun test --cwd packages/bunderstack-query`. Expected: PASS.

- [x] **Step 5: Commit** — `fix(bunderstack-query): deliver realtime events to custom applyEvent regardless of static tables list`

---

### Task 4: `bunderstack-sync` — `scopedCollection()` + `collectionByIds()` on table collections

**Files:**
- Modify: `packages/bunderstack-sync/src/collection.ts`
- Test: `packages/bunderstack-sync/src/scoped-collection.test.ts`

**Interfaces:**
- Consumes: `MAX_LIST_LIMIT` from `bunderstack-query` (Task 2).
- Produces (added to `createTableCollection`'s return, so every table on the sync client gets them):
  - `scopedCollection(options?: ScopedCollectionOptions): ScopedCollection<TRow>` where `ScopedCollection = { collection; loadMore(count?: number): Promise<void>; hasMore(): boolean; size(): number }`
  - `collectionByIds(ids: readonly TRow['id'][], options?: { column?: string }): Collection` (same collection type as `.collection`)
  - `applyRealtimeEvent(action: 'create' | 'update' | 'delete', record: Record<string, unknown>): void`
  - `refetchAll(): Promise<void>`

- [x] **Step 1: Write the failing test** — `packages/bunderstack-sync/src/scoped-collection.test.ts`. Reuse the paginated-mock-fetch style of `collection.test.ts`; the mock must honor `cursorMode`, `limit`, `cursor`, filters, and comma-joined `IN` params:

```ts
import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createTableCollection } from './collection'

type Post = { id: string; title: string; replyToId: string | null }

/** 450 root posts p001..p450, server pages capped at 200, cursor = last id. */
function paginatedFetchFactory() {
  const rows: Post[] = Array.from({ length: 450 }, (_, i) => ({
    id: `p${String(i + 1).padStart(3, '0')}`,
    title: `post ${i + 1}`,
    replyToId: null,
  }))
  const calls: string[] = []
  const fetchMock = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://test')
    calls.push(url.search)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 200)
    const idFilter = url.searchParams.get('id')
    if (idFilter) {
      const wanted = new Set(idFilter.split(','))
      return Response.json({
        items: rows.filter((r) => wanted.has(r.id)),
        limit,
        hasMore: false,
      })
    }
    const cursor = url.searchParams.get('cursor')
    const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0
    const items = rows.slice(start, start + limit)
    const hasMore = start + limit < rows.length
    return Response.json({
      items,
      limit,
      hasMore,
      nextCursor: hasMore ? items[items.length - 1]!.id : undefined,
    })
  }) as unknown as typeof fetch
  return { fetchMock, calls, rows }
}

function makeTable(fetchMock: typeof fetch) {
  return createTableCollection<Post>({
    tableName: 'posts',
    baseUrl: '/api',
    fetch: fetchMock,
    queryClient: new QueryClient(),
  })
}

describe('scopedCollection', () => {
  it('returns the same instance for the same options', () => {
    const t = makeTable(paginatedFetchFactory().fetchMock)
    const a = t.scopedCollection({ filter: { replyToId: null }, order: 'desc' })
    const b = t.scopedCollection({ filter: { replyToId: null }, order: 'desc' })
    expect(a).toBe(b)
    const c = t.scopedCollection({ filter: { replyToId: 'p1' }, order: 'desc' })
    expect(c).not.toBe(a)
  })

  it('grows the window across cursor pages and tracks hasMore', async () => {
    const { fetchMock } = paginatedFetchFactory()
    const t = makeTable(fetchMock)
    const scoped = t.scopedCollection({ initialCount: 20 })
    await scoped.collection.preload()
    expect(scoped.collection.size).toBe(20)
    expect(scoped.hasMore()).toBe(true)

    await scoped.loadMore(430) // to exactly 450 = table size
    expect(scoped.collection.size).toBe(450)
    expect(scoped.hasMore()).toBe(false)
    expect(scoped.size()).toBe(450)
  })
})

describe('collectionByIds', () => {
  it('chunks requests at the server cap and caches by id set', async () => {
    const { fetchMock, calls, rows } = paginatedFetchFactory()
    const t = makeTable(fetchMock)
    const ids = rows.slice(0, 250).map((r) => r.id)
    const byIds = t.collectionByIds(ids)
    expect(t.collectionByIds([...ids].reverse())).toBe(byIds) // order-insensitive cache
    await byIds.preload()
    expect(byIds.size).toBe(250)
    const idCalls = calls.filter((c) => c.includes('id='))
    expect(idCalls.length).toBe(2) // 200 + 50
  })

  it('returns an empty collection for no ids without fetching', async () => {
    const { fetchMock, calls } = paginatedFetchFactory()
    const t = makeTable(fetchMock)
    const byIds = t.collectionByIds([])
    await byIds.preload()
    expect(byIds.size).toBe(0)
    expect(calls.length).toBe(0)
  })
})

describe('applyRealtimeEvent', () => {
  it('upserts matching rows into scoped collections and skips non-matching', async () => {
    const { fetchMock } = paginatedFetchFactory()
    const t = makeTable(fetchMock)
    const feed = t.scopedCollection({ filter: { replyToId: null } })
    await feed.collection.preload()
    const before = feed.collection.size

    t.applyRealtimeEvent('create', { id: 'new1', title: 'x', replyToId: null })
    expect(feed.collection.size).toBe(before + 1)

    t.applyRealtimeEvent('create', { id: 'new2', title: 'y', replyToId: 'p001' })
    expect(feed.collection.get('new2')).toBeUndefined()

    // update that stops matching the filter removes the row from the scope
    t.applyRealtimeEvent('update', { id: 'new1', title: 'x', replyToId: 'p001' })
    expect(feed.collection.get('new1')).toBeUndefined()

    t.applyRealtimeEvent('delete', { id: 'p001' })
    expect(feed.collection.get('p001')).toBeUndefined()
  })
})
```

(If `collection.preload()` / `collection.size` aren't the actual TanStack DB APIs in this version, use whatever `collection.test.ts` uses to await first sync and count rows — mirror that file exactly.)

- [x] **Step 2: Run to verify failure** — `bun test --cwd packages/bunderstack-sync src/scoped-collection.test.ts`. Expected: FAIL (`scopedCollection` is not a function).

- [x] **Step 3: Implement** in `collection.ts`:

```ts
import { MAX_LIST_LIMIT } from 'bunderstack-query'

export type ScopedFilterValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number)[]

export type ScopedCollectionOptions = {
  /** Equality filters, e.g. `{ replyToId: null }` — must be filterableColumns server-side. */
  filter?: Record<string, ScopedFilterValue>
  sort?: string
  order?: 'asc' | 'desc'
  /** Rows per underlying request; clamped to the server cap (200). */
  pageSize?: number
  /** Window size on first load and default loadMore step. Defaults to 20. */
  initialCount?: number
}

export type ScopedCollection<TRow extends { id: string | number }> = {
  collection: /* same type createCollection returns for TRow */
  /** Grow the window by `count` (default initialCount) and refetch in place. */
  loadMore: (count?: number) => Promise<void>
  /** Whether the server reported rows beyond the current window (as of the last fetch). */
  hasMore: () => boolean
  /** Current desired window size. */
  size: () => number
}
```

Inside `createTableCollection`, after the existing `collection`:

```ts
type Registered = {
  collection: typeof collection
  matches: (record: Record<string, unknown>) => boolean
  refetch: () => Promise<void>
}
const registry: Registered[] = []

function matchesFilter(
  record: Record<string, unknown>,
  filter: Record<string, ScopedFilterValue>,
): boolean {
  for (const [col, expected] of Object.entries(filter)) {
    const actual = record[col]
    if (expected === null) {
      if (actual != null) return false
    } else if (Array.isArray(expected)) {
      if (!expected.map(String).includes(String(actual))) return false
    } else if (String(actual) !== String(expected)) return false
  }
  return true
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
  return `{${entries.join(',')}}`
}

const scopedCache = new Map<string, ScopedCollection<TRow>>()

function scopedCollection(
  options: ScopedCollectionOptions = {},
): ScopedCollection<TRow> {
  const pageSize = Math.min(options.pageSize ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT)
  const initialCount = options.initialCount ?? 20
  const filter = options.filter ?? {}
  const cacheKey = stableKey({
    filter,
    sort: options.sort ?? null,
    order: options.order ?? null,
    pageSize,
    initialCount,
  })
  const cached = scopedCache.get(cacheKey)
  if (cached) return cached

  let desiredCount = initialCount
  let serverHasMore = false

  const scoped = createCollection(
    queryCollectionOptions<TRow>({
      queryKey: [config.tableName, 'scoped', cacheKey],
      queryFn: async () => {
        // Growing window: walk cursor pages (each ≤ server cap) until the
        // current desired count is collected or the table runs out. Stable
        // across loadMore — refetching in place only ever adds rows, so
        // already-rendered items never unmount (no scroll jumps).
        const items: TRow[] = []
        let cursor: string | undefined
        let more = false
        while (items.length < desiredCount) {
          const remaining = Math.min(pageSize, desiredCount - items.length)
          const page = await table.list({
            ...filter,
            ...(options.sort ? { sort: options.sort } : {}),
            ...(options.order ? { order: options.order } : {}),
            cursorMode: true,
            limit: remaining,
            ...(cursor ? { cursor } : {}),
          })
          items.push(...page.items)
          more = Boolean(page.hasMore && page.nextCursor)
          if (!more) break
          cursor = page.nextCursor
        }
        serverHasMore = more
        return items.slice(0, desiredCount)
      },
      queryClient: config.queryClient,
      getKey: (item) => item.id,
    }),
  )

  const entry: ScopedCollection<TRow> = {
    collection: scoped,
    loadMore: async (count) => {
      desiredCount += count ?? initialCount
      await scoped.utils.refetch()
    },
    hasMore: () => serverHasMore,
    size: () => desiredCount,
  }
  registry.push({
    collection: scoped,
    matches: (record) => matchesFilter(record, filter),
    refetch: () => scoped.utils.refetch(),
  })
  scopedCache.set(cacheKey, entry)
  return entry
}

const byIdsCache = new Map<string, typeof collection>()

function collectionByIds(
  ids: readonly TRow['id'][],
  options: { column?: string } = {},
) {
  const column = options.column ?? 'id'
  const unique = Array.from(new Set(ids.map(String))).sort()
  const cacheKey = `${column}:${unique.join(',')}`
  const cached = byIdsCache.get(cacheKey)
  if (cached) return cached

  const idSet = new Set(unique)
  const byIds = createCollection(
    queryCollectionOptions<TRow>({
      queryKey: [config.tableName, 'byIds', column, unique],
      queryFn: async () => {
        if (unique.length === 0) return []
        const items: TRow[] = []
        for (let i = 0; i < unique.length; i += MAX_LIST_LIMIT) {
          const chunk = unique.slice(i, i + MAX_LIST_LIMIT)
          const page = await table.list({ [column]: chunk, limit: chunk.length })
          items.push(...page.items)
        }
        return items
      },
      queryClient: config.queryClient,
      getKey: (item) => item.id,
    }),
  )
  registry.push({
    collection: byIds,
    matches: (record) => idSet.has(String(record[column])),
    refetch: () => byIds.utils.refetch(),
  })
  byIdsCache.set(cacheKey, byIds)
  return byIds
}

function applyRealtimeEvent(
  action: 'create' | 'update' | 'delete',
  record: Record<string, unknown>,
) {
  const id = record['id'] as string | number
  if (action === 'delete') collection.utils.writeDelete(id)
  else collection.utils.writeUpsert(record)
  for (const entry of registry) {
    const present = entry.collection.get(id) !== undefined
    if (action === 'delete' || !entry.matches(record)) {
      if (present) entry.collection.utils.writeDelete(id)
    } else {
      entry.collection.utils.writeUpsert(record)
    }
  }
}

async function refetchAll() {
  await Promise.all([
    collection.utils.refetch(),
    ...registry.map((entry) => entry.refetch()),
  ])
}

return {
  collection,
  table: table as TableClient<TRow, TCreate, TUpdate>,
  scopedCollection,
  collectionByIds,
  applyRealtimeEvent,
  refetchAll,
}
```

Notes for the implementer:
- The base `collection.utils.writeDelete(id)` for a missing id: check TanStack DB behavior; if it throws on missing keys, guard with `collection.get(id) !== undefined` (same as the registry path).
- Type the `ScopedCollection.collection` field using the same inferred type as the existing `collection` const (e.g. `type CollectionOf<TRow ...> = ReturnType<typeof createCollection<...>>` or capture via `typeof collection`). Do not introduce `any`.
- `writeUpsert` in scoped collections only fires for rows already server-authorized (realtime broadcasts are access-filtered server-side).

- [x] **Step 4: Verify** — `bun test --cwd packages/bunderstack-sync` and `bunx tsc --noEmit -p packages/bunderstack-sync`. Expected: PASS (existing collection tests must still pass — the return object only gained members).

- [x] **Step 5: Commit** — `feat(bunderstack-sync): scopedCollection + collectionByIds primitives with realtime fan-out`

---

### Task 5: `bunderstack-sync` — lazy `createSyncClient<App>()` + realtime resolver + SSR default

**Files:**
- Create: `packages/bunderstack-sync/src/sync-client.ts`
- Modify: `packages/bunderstack-sync/src/realtime-sync.ts` (resolver mode)
- Modify: `packages/bunderstack-sync/src/index.ts` (exports; `.with()` realtime SSR default)
- Test: `packages/bunderstack-sync/src/sync-client.test.ts`

**Interfaces:**
- Consumes: Task 2 (`AnyBunderstackApp`, `InferTables`, `InferBuckets`, `lazyRecord`, bucket client), Task 3 (ungated `applyEvent`), Task 4 (`applyRealtimeEvent`, `refetchAll`).
- Produces:
  - `createSyncClient<TApp>(options: { queryClient: QueryClient; baseUrl?; fetch?; realtime?: boolean }): BunderstackSyncClient<TApp>` — `{ [table]: TableCollection } & { files: { [bucket]: BucketClient } } & { realtime }`; `realtime` defaults to `typeof window !== 'undefined'`.
  - `createSyncRealtimeClient` accepts either the legacy `collections` map or `{ resolve(table), resolveAll() }`.

- [x] **Step 1: Write the failing test** — `packages/bunderstack-sync/src/sync-client.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createSyncClient } from './sync-client'

type Row<T> = { $inferSelect: T; $inferInsert: Partial<T> }
type FakeApp = {
  $inferClient?: {
    schema: {
      posts: Row<{ id: string; title: string; userId: string }>
      user: Row<{ id: string; name: string }>
    }
    access: { posts: { ownerColumn: 'userId' }; user: { exposeAuthTable: true } }
    buckets: 'images'
  }
}

const emptyListFetch = (async () =>
  Response.json({ items: [], limit: 100, hasMore: false })) as unknown as typeof fetch

describe('createSyncClient', () => {
  it('lazily materializes table collections with stable identity', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    const posts = api.posts
    expect(posts.collection).toBeDefined()
    expect(typeof posts.table.list).toBe('function')
    expect(typeof posts.scopedCollection).toBe('function')
    expect(api.posts).toBe(posts)
  })

  it('exposes lazy bucket clients under files.*', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    expect(typeof api.files.images.upload).toBe('function')
  })

  it('disables realtime by default outside the browser (SSR)', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    expect(api.realtime).toBeUndefined() // bun test has no `window`
  })

  it('routes realtime events to lazily-created tables via the resolver', async () => {
    // realtime: true + mock SSE fetch that emits one posts create event
    // (reuse realtime-sync.test.ts's SSE harness); then:
    //   api.posts — materialize AFTER client creation
    //   await event delivery
    //   expect(api.posts.collection.get('p1')).toBeDefined()
  })
})
```

Fill in the fourth test using the exact SSE mock harness already present in `realtime-sync.test.ts`.

- [x] **Step 2: Run to verify failure** — `bun test --cwd packages/bunderstack-sync src/sync-client.test.ts`. Expected: FAIL (module missing).

- [x] **Step 3: Implement**

`realtime-sync.ts` — add resolver mode (keep legacy map working):

```ts
export type SyncRealtimeTarget = {
  applyRealtimeEvent: (
    action: 'create' | 'update' | 'delete',
    record: Record<string, unknown>,
  ) => void
  refetchAll: () => Promise<void>
}

export type SyncRealtimeConfig = {
  baseUrl: string
  queryClient: QueryClient
  fetch?: typeof fetch
  /** Static map of table name -> collection (legacy shape). */
  collections?: Record<string, SyncableCollection>
  /** Lazy lookup: resolve a table's target at event time (proxy clients). */
  resolve?: (table: string) => SyncRealtimeTarget | undefined
  /** All materialized targets — used for gap recovery. */
  resolveAll?: () => Iterable<SyncRealtimeTarget>
}

export function createSyncRealtimeClient(config: SyncRealtimeConfig) {
  const staticCollections = config.collections ?? {}
  const tables = Object.keys(staticCollections)

  return createRealtimeClient({
    baseUrl: config.baseUrl,
    queryClient: config.queryClient,
    tables,
    fetch: config.fetch,
    applyEvent: (evt: RealtimeEvent) => {
      if (config.resolve) {
        config.resolve(evt.table)?.applyRealtimeEvent(evt.action, evt.record)
        return
      }
      const collection = staticCollections[evt.table]
      if (!collection) return
      if (evt.action === 'delete') collection.utils.writeDelete(evt.record['id'])
      else collection.utils.writeUpsert(evt.record)
    },
    onGap: () => {
      if (config.resolveAll) {
        for (const target of config.resolveAll()) {
          target.refetchAll().catch((err) => {
            console.error('bunderstack-sync: gap-recovery refetch failed', err)
          })
        }
        return
      }
      for (const collection of Object.values(staticCollections)) {
        collection.utils.refetch().catch((err) => {
          console.error('bunderstack-sync: gap-recovery refetch failed', err)
        })
      }
    },
  })
}
```

`sync-client.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query'
import {
  attachBucketMutationOptions,
  createBucketClient,
  lazyRecord,
  type AnyBunderstackApp,
  type InferBuckets,
  type InferSchema,
  type InferTables,
  type FilesQueryClient,
} from 'bunderstack-query'

import { createTableCollection, type TableCollection } from './collection'
import { createSyncRealtimeClient } from './realtime-sync'

// RowFor / CreateFor: move from index.ts into this module (index re-imports).

export type SyncClientOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
  /** Live SSE updates. Defaults to true in the browser, false during SSR. */
  realtime?: boolean
}

export type BunderstackSyncClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableCollection<
    RowFor<InferSchema<TApp>, K>,
    CreateFor<InferSchema<TApp>, K>,
    Partial<RowFor<InferSchema<TApp>, K>>
  >
} & FilesQueryClient<InferBuckets<TApp>> & {
  realtime: ReturnType<typeof createSyncRealtimeClient> | undefined
}

/**
 * Fully typed sync client inferred from the server app. Tables, their
 * collections, and buckets materialize lazily on first access; realtime
 * events fan out to whichever collections exist (base + scoped + byIds).
 *
 * @example
 * import type { App } from './bunderstack'
 * const api = createSyncClient<App>({ queryClient })
 */
export function createSyncClient<TApp extends AnyBunderstackApp>(
  options: SyncClientOptions,
): BunderstackSyncClient<TApp> {
  const baseUrl = options.baseUrl ?? '/api'
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)

  const materialized = new Map<string, ReturnType<typeof createTableCollection>>()
  const tables = lazyRecord((tableName) => {
    const bundle = createTableCollection({
      tableName,
      baseUrl,
      fetch: fetchFn,
      queryClient: options.queryClient,
    })
    materialized.set(tableName, bundle)
    return bundle
  })

  const files = lazyRecord((bucket) => {
    const bucketClient = createBucketClient({ bucket, baseUrl, fetch: fetchFn })
    return {
      ...bucketClient,
      ...attachBucketMutationOptions(bucketClient, options.queryClient),
    }
  })

  // Realtime needs a browser-side persistent connection; default off in SSR.
  const realtimeEnabled = options.realtime ?? typeof window !== 'undefined'
  const realtime = realtimeEnabled
    ? createSyncRealtimeClient({
        baseUrl,
        queryClient: options.queryClient,
        fetch: fetchFn as typeof fetch,
        resolve: (table) => materialized.get(table),
        resolveAll: () => materialized.values(),
      })
    : undefined

  return new Proxy({} as BunderstackSyncClient<TApp>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'files') return files
      if (prop === 'realtime') return realtime
      if (prop === 'then' || prop === 'toJSON' || prop === 'constructor' || prop === '$$typeof')
        return undefined
      return (tables as Record<string, unknown>)[prop]
    },
    has: (_t, prop) => typeof prop === 'string',
  }) as BunderstackSyncClient<TApp>
}
```

`index.ts` changes:
- `export { createSyncClient } from './sync-client'` + `export type { BunderstackSyncClient, SyncClientOptions } from './sync-client'`.
- Re-export inference types for downstream: `export type { AnyBunderstackApp, InferSchema, InferTables, InferBuckets } from 'bunderstack-query'`.
- In the legacy `.with()`: change the realtime condition from `options.realtime === false ? undefined : create(...)` to `(options.realtime ?? typeof window !== 'undefined') ? create(...) : undefined`.

- [x] **Step 4: Verify** — `bun test --cwd packages/bunderstack-sync` and `bunx tsc --noEmit -p packages/bunderstack-sync`. Expected: PASS, including pre-existing tests (legacy `.with()` tests that relied on realtime-on-by-default must now pass `realtime: true` explicitly if they run without `window` — update those tests, that default change is intended).

- [x] **Step 5: Commit** — `feat(bunderstack-sync): type-inferred lazy createSyncClient<App>() with realtime resolver and SSR-safe default`

---

### Task 6: new package `bunderstack-start` — TanStack Start adapter

**Files:**
- Create: `packages/bunderstack-start/package.json`
- Create: `packages/bunderstack-start/tsconfig.json` (copy from `packages/bunderstack-sync/tsconfig.json`)
- Create: `packages/bunderstack-start/src/isomorphic-fetch.ts`
- Create: `packages/bunderstack-start/src/index.ts`
- Modify: root `package.json` test script
- Test: `packages/bunderstack-start/src/index.test.ts`

**Interfaces:**
- Consumes: `createSyncClient`, `AnyBunderstackApp`, `BunderstackSyncClient` from Task 5.
- Produces:
  - `bunderstackStart<TApp>(options?: { baseUrl?: string; staleTime?: number }): { createQueryClient(): QueryClient; createApi(queryClient: QueryClient): BunderstackSyncClient<TApp> }`
  - `createIsomorphicFetch(options?: { fetch?: typeof fetch }): (input, init?) => Promise<Response>`
  - `createApiHandlers(app: { handler(req: Request): Promise<Response> }): { GET; POST; PATCH; DELETE }` (each `({ request }) => app.handler(request)`)
  - `getSessionUser(app, request): Promise<{ id: string; email: string; name: string; image?: string | null } | null>`
  - `createStartAuthClient(options?: { baseURL?: string })` — BetterAuth react client with browser-origin default.

- [x] **Step 1: package.json / tsconfig**

```json
{
  "name": "bunderstack-start",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "bun test" },
  "dependencies": {
    "bunderstack-query": "workspace:*",
    "bunderstack-sync": "workspace:*"
  },
  "devDependencies": {
    "@tanstack/react-query": "^5.101.1",
    "@tanstack/react-start": "^1.168.26",
    "@types/bun": "^1.3.14",
    "better-auth": "^1.0.0",
    "typescript": "^5.0.0"
  },
  "peerDependencies": {
    "@tanstack/react-query": "^5.101.0",
    "@tanstack/react-start": ">=1.0.0",
    "better-auth": "^1.0.0",
    "typescript": "^5"
  },
  "peerDependenciesMeta": { "better-auth": { "optional": true } }
}
```

Root `package.json` test script gains `&& bun test --cwd packages/bunderstack-start`. Run `bun install` after creating the package.

- [x] **Step 2: Write the failing test** — `src/index.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'

import {
  bunderstackStart,
  createApiHandlers,
  createIsomorphicFetch,
  getSessionUser,
} from './index'

describe('createApiHandlers', () => {
  it('forwards every method to app.handler', async () => {
    const seen: string[] = []
    const app = {
      handler: async (req: Request) => {
        seen.push(req.method)
        return new Response('ok')
      },
    }
    const handlers = createApiHandlers(app)
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      const res = await handlers[method]({
        request: new Request('http://x/api/posts', { method }),
      })
      expect(await res.text()).toBe('ok')
    }
    expect(seen).toEqual(['GET', 'POST', 'PATCH', 'DELETE'])
  })
})

describe('createIsomorphicFetch', () => {
  it('resolves relative URLs against APP_URL on the server', async () => {
    const urls: string[] = []
    const inner = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}')
    }) as unknown as typeof fetch
    process.env.APP_URL = 'http://example.test:1234'
    const iso = createIsomorphicFetch({ fetch: inner })
    await iso('/api/posts')
    expect(urls[0]).toBe('http://example.test:1234/api/posts')
    delete process.env.APP_URL
  })

  it('passes absolute URLs through untouched', async () => {
    const urls: string[] = []
    const inner = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}')
    }) as unknown as typeof fetch
    const iso = createIsomorphicFetch({ fetch: inner })
    await iso('http://other.test/x')
    expect(urls[0]).toBe('http://other.test/x')
  })
})

describe('bunderstackStart', () => {
  it('builds a query client with the default staleTime and a sync api', () => {
    const { createQueryClient, createApi } = bunderstackStart()
    const qc = createQueryClient()
    expect(qc.getDefaultOptions().queries?.staleTime).toBe(30_000)
    const api = createApi(qc)
    expect(api.realtime).toBeUndefined() // SSR default in tests
  })
})

describe('getSessionUser', () => {
  it('returns the session user or null', async () => {
    const app = {
      auth: {
        api: {
          getSession: async () => ({
            user: { id: 'u1', email: 'a@b.c', name: 'A', image: null },
          }),
        },
      },
    }
    const user = await getSessionUser(app, new Request('http://x/'))
    expect(user?.id).toBe('u1')
    const anon = {
      auth: { api: { getSession: async () => null } },
    }
    expect(await getSessionUser(anon, new Request('http://x/'))).toBeNull()
  })
})
```

Run: `bun test --cwd packages/bunderstack-start`. Expected: FAIL (module missing).

- [x] **Step 3: Implement**

`src/isomorphic-fetch.ts`:

```ts
/**
 * SSR-aware fetch: the browser passes `/api/...` through as-is; on the
 * server, relative URLs are resolved against the incoming request's origin
 * (via @tanstack/react-start/server), falling back to APP_URL /
 * BETTER_AUTH_URL / localhost:3000 outside a request context.
 *
 * The dynamic import is marked vite-ignore so client bundles never try to
 * resolve the server-only module; the `window` guard means it never runs
 * there either.
 */
export function createIsomorphicFetch(options: { fetch?: typeof fetch } = {}) {
  const inner = options.fetch ?? fetch
  return async function isomorphicFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (typeof window !== 'undefined') return inner(input, init)
    if (typeof input === 'string' && input.startsWith('/')) {
      let origin: string | undefined
      try {
        const mod = await import(
          /* @vite-ignore */ '@tanstack/react-start/server'
        )
        origin = new URL(mod.getRequest().url).origin
      } catch {
        // No request context (background job, test) — fall through to env.
      }
      origin ??=
        process.env.APP_URL ??
        process.env.BETTER_AUTH_URL ??
        'http://localhost:3000'
      return inner(new URL(input, origin), init)
    }
    return inner(input, init)
  }
}
```

`src/index.ts`:

```ts
import { QueryClient } from '@tanstack/react-query'
import {
  createSyncClient,
  type AnyBunderstackApp,
  type BunderstackSyncClient,
} from 'bunderstack-sync'

import { createIsomorphicFetch } from './isomorphic-fetch'

export { createIsomorphicFetch } from './isomorphic-fetch'

export type BunderstackStartOptions = {
  /** API mount point. Defaults to '/api'. */
  baseUrl?: string
  /** Default query staleTime (ms). Defaults to 30_000. */
  staleTime?: number
}

/**
 * One-call client setup for TanStack Start apps.
 *
 * @example
 * // src/client.ts
 * import type { App } from './bunderstack'
 * export const { createQueryClient, createApi } = bunderstackStart<App>()
 */
export function bunderstackStart<TApp extends AnyBunderstackApp>(
  options: BunderstackStartOptions = {},
) {
  const isoFetch = createIsomorphicFetch()
  return {
    createQueryClient: () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: options.staleTime ?? 30_000 },
        },
      }),
    createApi: (queryClient: QueryClient): BunderstackSyncClient<TApp> =>
      createSyncClient<TApp>({
        queryClient,
        fetch: isoFetch,
        baseUrl: options.baseUrl,
      }),
  }
}

type StartRequestContext = { request: Request }
type StartHandler = (ctx: StartRequestContext) => Promise<Response>

/**
 * Handlers object for the catch-all API file route.
 *
 * @example
 * // src/routes/api/$.tsx
 * export const Route = createFileRoute('/api/$')({
 *   server: { handlers: createApiHandlers(app) },
 * })
 */
export function createApiHandlers(app: {
  handler: (req: Request) => Promise<Response>
}): { GET: StartHandler; POST: StartHandler; PATCH: StartHandler; DELETE: StartHandler } {
  const handle: StartHandler = ({ request }) => app.handler(request)
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle }
}

export type SessionUser = {
  id: string
  email: string
  name: string
  image?: string | null
}

type SessionApp = {
  auth: {
    api: {
      getSession: (opts: {
        headers: Headers
      }) => Promise<{ user: SessionUser | null } | null>
    }
  }
}

/** Resolve the BetterAuth session user for an incoming request (server-side). */
export async function getSessionUser(
  app: SessionApp,
  request: Request,
): Promise<SessionUser | null> {
  const session = await app.auth.api.getSession({ headers: request.headers })
  return session?.user ?? null
}

/**
 * BetterAuth browser client pointed at the Bunderstack handler's /api/auth/*.
 * Import lazily to keep better-auth optional for apps that don't use it.
 */
export async function createStartAuthClient(options: { baseURL?: string } = {}) {
  const { createAuthClient } = await import('better-auth/react')
  return createAuthClient({
    baseURL:
      options.baseURL ??
      (typeof window !== 'undefined'
        ? window.location.origin
        : (process.env.APP_URL ?? 'http://localhost:3000')),
  })
}
```

Note: if the async `createStartAuthClient` proves awkward for module-scope use in the examples (it does — `authClient` is imported synchronously), make it synchronous with a top-level static import instead and keep `better-auth` a required peer. Decide during Task 7 when wiring the example; prefer the synchronous version:

```ts
import { createAuthClient } from 'better-auth/react'
export function createStartAuthClient(options: { baseURL?: string } = {}) {
  return createAuthClient({ baseURL: /* same default chain */ })
}
```

- [x] **Step 4: Verify** — `bun install` (workspace link), `bun test --cwd packages/bunderstack-start`, `bunx tsc --noEmit -p packages/bunderstack-start`, and root `bun run test`. Expected: PASS.

- [x] **Step 5: Commit** — `feat(bunderstack-start): TanStack Start adapter — one-call client, api handlers, isomorphic fetch, session helper`

---

### Task 7: migrate `examples/twitter-db-tanstack` to the inferred stack

**Files:**
- Modify: `examples/twitter-db-tanstack/src/bunderstack.ts` (add `export type App = typeof app`)
- Create: `examples/twitter-db-tanstack/src/client.ts`
- Delete: `examples/twitter-db-tanstack/src/collections.ts`
- Modify: `examples/twitter-db-tanstack/src/router.tsx`
- Modify: `examples/twitter-db-tanstack/src/routes/index.tsx`, `posts.$postId.tsx`, `users.$userId.tsx`, `profile.tsx`, `api/$.tsx`, `__root.tsx`
- Modify: `examples/twitter-db-tanstack/src/utils/session.ts`, `src/utils/auth-client.ts`
- Modify: `examples/twitter-db-tanstack/package.json` (add `"bunderstack-start": "workspace:*"`)

**Interfaces:**
- Consumes: everything from Tasks 1–6.

- [x] **Step 1: server + client entry**

`src/bunderstack.ts` — append:

```ts
export type App = typeof app
```

New `src/client.ts` (replaces all of `collections.ts`):

```ts
import { bunderstackStart } from 'bunderstack-start'

import type { App } from './bunderstack'

export const { createQueryClient, createApi } = bunderstackStart<App>()

export type SyncApi = ReturnType<typeof createApi>
```

`src/router.tsx` — swap the import:

```ts
import { createApi, createQueryClient, type SyncApi } from './client'
```

and `createSyncApi(queryClient)` → `createApi(queryClient)`.

- [x] **Step 2: routes**

`routes/api/$.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { createApiHandlers } from 'bunderstack-start'

import { app } from '~/bunderstack'

export const Route = createFileRoute('/api/$')({
  server: { handlers: createApiHandlers(app) },
})
```

`routes/__root.tsx` — subscribe realtime once for the app's tables (inside the root component; realtime is undefined during SSR so this is a no-op there):

```tsx
const { api } = Route.useRouteContext()
React.useEffect(() => {
  void api.realtime?.subscribe(['posts', 'user', 'follows', 'likes', 'retweets'])
}, [api])
```

`routes/index.tsx` — `FeedList` drops the desiredCount ref/state plumbing and the imported factory functions:

```tsx
function FeedList({ tab, user }: { tab: 'for-you' | 'following'; user: RouterContext['user'] }) {
  const { api } = Route.useRouteContext()
  const [loadingMore, setLoadingMore] = React.useState(false)

  const feed = api.posts.scopedCollection({
    filter: { replyToId: null },
    sort: 'createdAt',
    order: 'desc',
  })

  const loadMore = React.useCallback(async () => {
    setLoadingMore(true)
    try {
      await feed.loadMore()
    } finally {
      setLoadingMore(false)
    }
  }, [feed])

  const { data: allPosts } = useLiveQuery(
    (q) => q.from({ post: feed.collection }).orderBy(({ post }) => post.createdAt, 'desc'),
    [feed.collection],
  )
  const posts = allPosts ?? []

  const authorIds = React.useMemo(
    () => Array.from(new Set(posts.map((p) => p.userId))).sort(),
    [posts],
  )
  const usersById = api.user.collectionByIds(authorIds)
  const { data: users } = useLiveQuery((q) => q.from({ user: usersById }), [usersById])
  /* likes/retweets/follows liveQueries, authorMap, followingIds, feed-tab filter: unchanged */

  const hasMore = feed.hasMore()
  /* render: unchanged, LoadMore uses hasMore/loadingMore/loadMore */
}
```

Note `api.posts.scopedCollection(...)` and `api.user.collectionByIds(ids)` are cache-stable across renders (Task 4), so no `useMemo` is required around them.

`routes/posts.$postId.tsx` — same treatment:

```tsx
const replies = api.posts.scopedCollection({
  filter: { replyToId: postId },
  sort: 'createdAt',
  order: 'asc',
})
/* loadMore/hasMore identical to index.tsx; authors: */
const usersById = api.user.collectionByIds(authorIds)
```

`routes/users.$userId.tsx`:

```tsx
const userPosts = api.posts.scopedCollection({
  filter: { userId },
  sort: 'createdAt',
  order: 'desc',
})
```

`routes/profile.tsx`:

```tsx
const profileUser = api.user.collectionByIds([userId])
```

Remove all `~/collections` imports; delete `src/collections.ts`.

- [x] **Step 3: utils**

`utils/session.ts`:

```ts
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { asTypeId } from 'bunderstack/typeid'
import { getSessionUser } from 'bunderstack-start'

import { app } from '~/bunderstack'

export const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  if (!request) return null
  const user = await getSessionUser(app, request)
  if (!user) return null
  try {
    return {
      id: asTypeId('user', user.id),
      email: user.email,
      name: user.name,
      image: user.image,
    }
  } catch {
    // Stale session from before TypeID migration — treat as logged out.
    return null
  }
})
```

`utils/auth-client.ts`:

```ts
import { createStartAuthClient } from 'bunderstack-start'

export const authClient = createStartAuthClient()
```

- [x] **Step 4: Verify**

- `bun install`
- `bunx tsc --noEmit -p examples/twitter-db-tanstack` (or the example's own typecheck script if present)
- `bun run --cwd examples/twitter-db-tanstack build` — must succeed (proves the vite client bundle doesn't choke on the adapter's server-only dynamic import)
- Smoke: `bun run --cwd examples/twitter-db-tanstack dev` in background, `curl -s localhost:3003/ | head -c 200` returns HTML, `curl -s localhost:3003/api/posts?limit=1` returns JSON; kill the server.

- [x] **Step 5: Commit** — `refactor(twitter-db-tanstack): adopt inferred createSyncClient via bunderstack-start; replace hand-rolled collections with scopedCollection/collectionByIds`

---

### Task 8: migrate `examples/tldraw`

**Files:**
- Modify: `examples/tldraw/src/bunderstack.ts` (add `export type App = typeof app`)
- Create: `examples/tldraw/src/client.ts`
- Delete: `examples/tldraw/src/api-client.ts`
- Modify: `examples/tldraw/src/router.tsx`, `src/routes/api/$.tsx` (if present — check), `src/routes/canvas.$id.tsx`, `src/utils/auth-client.ts`, `src/utils/session.ts`
- Modify: `examples/tldraw/package.json` (add `"bunderstack-start": "workspace:*"`)

- [x] **Step 1: client entry**

`src/client.ts`:

```ts
import { bunderstackStart } from 'bunderstack-start'

import type { App } from './bunderstack'

export const { createQueryClient, createApi } = bunderstackStart<App>()

export type AppApi = ReturnType<typeof createApi>
```

Delete `api-client.ts`. The `feedParams` / `replyParams` / `byColumnIn` / `SCOPED_FETCH_LIMIT` exports there are dead twitter leftovers — before deleting, grep each remaining import site (`router.tsx`, `routes/canvas.$id.tsx`, `utils/canvas-data.ts`) and move anything actually used (e.g. `listParams`) into `utils/canvas-data.ts`. `filesApi` users switch to `api.files.images` from route context (`const { api } = Route.useRouteContext()` — already available in `canvas.$id.tsx`).

- [x] **Step 2: wiring** — `router.tsx` imports from `./client`; api route file uses `createApiHandlers(app)`; `utils/auth-client.ts` uses `createStartAuthClient()`; `utils/session.ts` uses `getSessionUser(app, request)` (this example's session shape — keep its existing return mapping). Keep the existing `api.realtime?.subscribe(['canvas', 'shape'])` calls — they work unchanged.

- [x] **Step 3: Verify** — `bun test --cwd examples/tldraw` (it has unit tests), `bunx tsc --noEmit -p examples/tldraw`, `bun run --cwd examples/tldraw build`, dev-server smoke as in Task 7 (port per its config).

- [x] **Step 4: Commit** — `refactor(tldraw): adopt bunderstack-start + inferred client; drop api-client boilerplate`

---

### Task 9: docs

**Files:**
- Modify: `README.md` (client section)
- Modify: `examples/README.md` (mention `bunderstack-start` if it lists packages)

- [x] **Step 1:** Update the README's client-side section (and add `bunderstack-start` to any package table) to show the end state:

```ts
// server: src/bunderstack.ts
export const app = createBunderstack({ schema, access, storage, realtime: true })
export type App = typeof app

// client: src/client.ts — everything else is inferred from App
import { bunderstackStart } from 'bunderstack-start'
import type { App } from './bunderstack'
export const { createQueryClient, createApi } = bunderstackStart<App>()

// in components
api.posts.scopedCollection({ filter: { replyToId: null }, sort: 'createdAt', order: 'desc' })
api.user.collectionByIds(authorIds)
api.files.images.upload(file)
```

Also document: tables/buckets are inferred (no tuples), realtime defaults off during SSR, `MAX_LIST_LIMIT` is exported, and `Object.keys(api)` is empty by design (lazy proxy).

- [x] **Step 2: Commit** — `docs: document inferred clients, bunderstack-start, and scoped collections`

---

## Self-Review Notes

- All four approved findings are covered: (1) Tasks 1–2–5, (2) Task 6, (3) Task 4, (4) Tasks 1/2 (`MAX_LIST_LIMIT`), 5 (SSR realtime default), 4 (auto-chunked IN filters via `collectionByIds`).
- Deliberately out of scope per user: TypeID/auth `generateId` defaults (finding 5) — revisit later with a non-enforcing suggestion.
- Known accepted trade-offs (documented in code): lazy proxies don't enumerate keys; scoped/byIds caches are unbounded per table-collection instance (bounded in practice by distinct filter shapes per page).
