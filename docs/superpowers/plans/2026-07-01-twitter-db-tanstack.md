# twitter-db-tanstack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/bunderstack-sync` (TanStack DB collections generated from a Bunderstack schema, with live SSE sync) and a new `examples/twitter-db-tanstack` example that uses it, with Tailwind v4 + shadcn/ui instead of `@knadh/oat`.

**Architecture:** A small, non-breaking refactor makes `bunderstack-query`'s realtime client's event-handling pluggable. `bunderstack-sync` wraps `bunderstack-query`'s `createTableClient` in `@tanstack/query-db-collection`'s `queryCollectionOptions`, and wires the pluggable realtime client to call `collection.utils.writeUpsert`/`writeDelete` directly (no invalidate-and-refetch). The example is copied from `twitter-tanstack` and its data/UI layers are replaced; backend (schema/access/auth) carries over almost unchanged.

**Tech Stack:** Bun, Drizzle, Hono, BetterAuth (unchanged) · `@tanstack/react-db`, `@tanstack/query-db-collection` (new) · Tailwind v4, shadcn/ui (Radix), `sonner` (new, replaces `@knadh/oat`)

**Design doc:** `docs/plans/2026-07-01-twitter-db-tanstack-design.md` — read this first for the "why."

## Global Constraints

- Never commit unless explicitly told to in this plan's steps (every commit step is explicit; do not add extra commits).
- `packages/bunderstack-query`'s existing test suite (`bun test packages/bunderstack-query`) must pass unchanged after Phase 1 — this is the proof the refactor is non-breaking.
- `examples/twitter-tanstack` is not modified by this plan. If a step would touch it, stop and re-read the design doc.
- All new/modified TypeScript must pass `bunx tsc --noEmit` (run from repo root, scoped per package/example as shown in each task).
- Primary key convention: every Bunderstack CRUD table uses `id` (a `TypeId<P>` string) as its primary key — `getKey: (item) => item.id` is safe everywhere in this plan, no per-table overrides needed.
- Phase 5 (route/component ports) tasks specify the **exact API surface to use** and **which existing `twitter-tanstack` file to port from**, rather than full inline JSX — port the referenced file's structure/JSX, replacing only the named data-layer and UI-library calls. This is a deliberate scoping choice (see "Task Right-Sizing" in this plan's own process): these are adaptations of an already-correct, already-tested reference implementation, not new design.

---

## Phase 1 — Pluggable realtime client (`packages/bunderstack-query`)

### Task 1.1: Export `RealtimeEvent` and add pluggable `applyEvent`/`onGap` config

**Files:**
- Modify: `packages/bunderstack-query/src/realtime-client.ts`
- Modify: `packages/bunderstack-query/src/index.ts:235-236`
- Test: `packages/bunderstack-query/src/realtime-client.test.ts` (existing — must still pass; new test appended)

**Interfaces:**
- Consumes: nothing new — this task only changes `realtime-client.ts` internals and exports.
- Produces: `RealtimeEvent` (exported type: `{ eventId: number; action: 'create' | 'update' | 'delete'; table: string; record: Record<string, unknown> }`), and two new optional `RealtimeClientConfig` fields:
  - `applyEvent?: (evt: RealtimeEvent) => void` — when provided, called instead of the default `setQueryData`/`invalidateQueries` patch.
  - `onGap?: () => void` — when provided, called instead of the default "invalidate every subscribed table's list query" on reconnect-gap.

- [ ] **Step 1: Read the current `apply`/`invalidateAllSubscribed` functions to confirm line numbers before editing**

Run: `grep -n "^function apply\|^function invalidateAllSubscribed\|^type RealtimeEvent" packages/bunderstack-query/src/realtime-client.ts`

Expected output (line numbers may have drifted slightly — use whatever this prints, not the numbers below):
```
26:type RealtimeEvent = {
78:function apply(evt: RealtimeEvent) {
89:function invalidateAllSubscribed() {
```

- [ ] **Step 2: Export `RealtimeEvent` and add the two new config fields**

In `packages/bunderstack-query/src/realtime-client.ts`, change:
```ts
type RealtimeEvent = {
  eventId: number
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}
```
to:
```ts
export type RealtimeEvent = {
  eventId: number
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}
```

In the same file, in `RealtimeClientConfig`, add two fields after `onStatus`:
```ts
export type RealtimeClientConfig = {
  baseUrl: string
  queryClient: QueryClient
  tables: string[]
  fetch?: typeof fetch
  keepaliveMs?: number
  onStatus?: (s: RealtimeStatus) => void
  /**
   * Override how an event is applied to local state. Defaults to patching
   * the TanStack Query cache (setQueryData on detail key + invalidateQueries
   * on the list key). Set this to integrate with a different local store
   * (e.g. a TanStack DB collection's direct-write API).
   */
  applyEvent?: (evt: RealtimeEvent) => void
  /**
   * Override full-resync-on-gap behavior. Defaults to invalidating every
   * subscribed table's list query.
   */
  onGap?: () => void
}
```

- [ ] **Step 3: Make `apply` delegate to `config.applyEvent` when provided**

Change the `apply` function from:
```ts
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
```
to:
```ts
  function apply(evt: RealtimeEvent) {
    const keys = keysByTable.get(evt.table)
    if (!keys) return
    if (typeof evt.eventId === 'number') lastEventId = evt.eventId
    if (config.applyEvent) {
      config.applyEvent(evt)
      return
    }
    const id = evt.record['id'] as string | number
    if (evt.action === 'delete')
      queryClient.removeQueries({ queryKey: keys.detail(id) })
    else queryClient.setQueryData(keys.detail(id), evt.record)
    queryClient.invalidateQueries({ queryKey: keys.lists() })
  }
```

- [ ] **Step 4: Make `invalidateAllSubscribed` delegate to `config.onGap` when provided**

Change:
```ts
  function invalidateAllSubscribed() {
    for (const t of tables) {
      const keys = keysByTable.get(t)
      if (keys) queryClient.invalidateQueries({ queryKey: keys.lists() })
    }
  }
```
to:
```ts
  function invalidateAllSubscribed() {
    if (config.onGap) {
      config.onGap()
      return
    }
    for (const t of tables) {
      const keys = keysByTable.get(t)
      if (keys) queryClient.invalidateQueries({ queryKey: keys.lists() })
    }
  }
```

- [ ] **Step 5: Export `RealtimeEvent` from the package's public API**

In `packages/bunderstack-query/src/index.ts`, change:
```ts
export { createRealtimeClient } from './realtime-client'
export type { RealtimeClientConfig } from './realtime-client'
```
to:
```ts
export { createRealtimeClient } from './realtime-client'
export type { RealtimeClientConfig, RealtimeEvent } from './realtime-client'
```

- [ ] **Step 6: Run the existing realtime-client tests — must still pass unchanged**

Run: `bun test packages/bunderstack-query/src/realtime-client.test.ts`
Expected: `2 pass, 0 fail` (same two tests as before — this proves the refactor didn't change default behavior).

- [ ] **Step 7: Write a new test proving `applyEvent`/`onGap` override the defaults**

Append to `packages/bunderstack-query/src/realtime-client.test.ts`:
```ts
it('uses applyEvent/onGap overrides instead of the default cache patching', async () => {
  const qc = new QueryClient()
  const stream = makeStreamResponse()
  const applied: any[] = []
  let gapCalled = false
  const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ gap: false }), { status: 200 })
    }
    return stream.response
  }) as unknown as typeof fetch

  const rt = createRealtimeClient({
    baseUrl: 'http://x/api',
    queryClient: qc,
    tables: ['cards'],
    fetch: fetchMock,
    applyEvent: (evt) => applied.push(evt),
    onGap: () => {
      gapCalled = true
    },
  })
  stream.push({ clientId: 'c1' })
  await rt.subscribe(['cards'])
  stream.push({
    eventId: 1,
    action: 'create',
    table: 'cards',
    record: { id: 'card_1', title: 'A' },
  })
  await new Promise((r) => setTimeout(r, 5))

  expect(applied).toEqual([
    { eventId: 1, action: 'create', table: 'cards', record: { id: 'card_1', title: 'A' } },
  ])
  // Default cache-patching must NOT have run.
  expect(qc.getQueryData(['cards', 'detail', 'card_1'])).toBeUndefined()
  expect(gapCalled).toBe(false)
  rt.close()
})
```

This test needs `createRealtimeClient` already imported (it is, at the top of the file) — no new imports required.

- [ ] **Step 8: Run the full realtime-client test file**

Run: `bun test packages/bunderstack-query/src/realtime-client.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 9: Run the full bunderstack-query suite to confirm nothing else broke**

Run: `bun test packages/bunderstack-query`
Expected: all tests pass (same count as baseline — `bun test packages/bunderstack-query` before this task started, plus the 1 new test).

- [ ] **Step 10: Typecheck**

Run: `bunx tsc --noEmit -p packages/bunderstack-query` (if no `tsconfig.json` at that path, run `bunx tsc --noEmit --strict packages/bunderstack-query/src/realtime-client.ts packages/bunderstack-query/src/index.ts` instead)
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/bunderstack-query/src/realtime-client.ts packages/bunderstack-query/src/index.ts packages/bunderstack-query/src/realtime-client.test.ts
git commit -m "feat(bunderstack-query): make realtime client's event handling pluggable

Exports RealtimeEvent and adds optional applyEvent/onGap config fields so
consumers other than TanStack Query (e.g. a future TanStack DB adapter) can
hook the SSE event stream without reimplementing reconnect/backoff/gap
recovery. Default behavior (cache patch + invalidate) is unchanged."
```

---

## Phase 2 — `packages/bunderstack-sync`

### Task 2.1: Package scaffold

**Files:**
- Create: `packages/bunderstack-sync/package.json`
- Create: `packages/bunderstack-sync/tsconfig.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a workspace package named `bunderstack-sync`, installable via `bun install` from repo root (workspaces glob `packages/*` already covers it — no root `package.json` edit needed).

- [ ] **Step 1: Create `packages/bunderstack-sync/package.json`**

```json
{
  "name": "bunderstack-sync",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "bunderstack": "workspace:*",
    "bunderstack-query": "workspace:*"
  },
  "devDependencies": {
    "@tanstack/query-core": "^5.101.1",
    "@tanstack/react-query": "^5.101.1",
    "@tanstack/react-db": "^0.1.91",
    "@tanstack/query-db-collection": "^1.0.45",
    "@types/bun": "^1.3.14"
  },
  "peerDependencies": {
    "@tanstack/react-query": "^5.101.0",
    "@tanstack/react-db": "^0.1.0",
    "@tanstack/query-db-collection": "^1.0.0",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Create `packages/bunderstack-sync/tsconfig.json`** (mirror `packages/bunderstack-query`'s if it has one)

Run: `cat packages/bunderstack-query/tsconfig.json 2>/dev/null || echo "no tsconfig in bunderstack-query — skip this file, bunderstack-sync doesn't need one either"`

If it prints a tsconfig, copy it verbatim into `packages/bunderstack-sync/tsconfig.json` with no changes (same compiler settings, this is a sibling package). If it prints the "skip" message, do not create the file — move on.

- [ ] **Step 3: Install dependencies from repo root**

Run: `cd /Users/kirill/pet-projects/bunderstack && bun install`
Expected: exits 0, `node_modules/bunderstack-sync` is a symlink into `packages/bunderstack-sync`, and `node_modules/.bun/@tanstack+react-db@*` / `@tanstack+query-db-collection@*` directories now exist.

- [ ] **Step 4: Verify the symlink and new deps**

Run: `ls -la node_modules/bunderstack-sync && find node_modules/.bun -maxdepth 1 -iname '*react-db*' -o -iname '*query-db-collection*'`
Expected: symlink present, both package directories found.

No commit yet — this task has no source files to commit besides config; fold the commit into Task 2.2.

---

### Task 2.2: `createTableCollection` — wraps one table as a TanStack DB collection

**Files:**
- Create: `packages/bunderstack-sync/src/collection.ts`
- Test: `packages/bunderstack-sync/src/collection.test.ts`

**Interfaces:**
- Consumes: `createTableClient` from `bunderstack-query` (signature: `createTableClient<TRow, TCreate, TUpdate>(config: { tableName: string; baseUrl: string; fetch: (input, init?) => Promise<Response> }) => { keys, list, get, create, update, delete, listQuery, listInfiniteQuery, getQuery }` — see `packages/bunderstack-query/src/table-client.ts`). `createCollection` from `@tanstack/react-db`. `queryCollectionOptions` from `@tanstack/query-db-collection`.
- Produces: `createTableCollection<TRow extends { id: string | number }, TCreate, TUpdate>(config: TableCollectionConfig) => { collection: Collection<TRow>; table: TableClient<TRow, TCreate, TUpdate> }`, where:
```ts
export type TableCollectionConfig = {
  tableName: string
  baseUrl: string
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
  /** Rows per sync fetch. Defaults to 100. Posts/feed-shaped tables that need
   * real pagination are handled separately in the example via a growing
   * limit — see Phase 4, Task 4.2. */
  limit?: number
}
```
  The returned `table` is exposed so callers (e.g. the example's `collections.ts`) can also call `table.list(...)` directly for ad hoc scoped reads outside the live-query system, same as `bunderstack-query` consumers do today.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack-sync/src/collection.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createTableCollection } from './collection'

type Card = { id: string; title: string }

function fetchMockFactory() {
  const db = new Map<string, Card>([
    ['card_1', { id: 'card_1', title: 'A' }],
    ['card_2', { id: 'card_2', title: 'B' }],
  ])
  const calls: { method: string; url: string; body?: unknown }[] = []

  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })

    if (method === 'GET' && url.includes('/cards?')) {
      return new Response(
        JSON.stringify({
          items: [...db.values()],
          limit: 100,
          hasMore: false,
        }),
        { status: 200 },
      )
    }
    if (method === 'POST' && url.endsWith('/cards')) {
      const body = JSON.parse(String(init!.body))
      const created = { id: 'card_3', title: body.title }
      db.set(created.id, created)
      return new Response(JSON.stringify(created), { status: 200 })
    }
    if (method === 'PATCH') {
      const id = url.split('/').pop()!
      const body = JSON.parse(String(init!.body))
      const updated = { ...db.get(id)!, ...body }
      db.set(id, updated)
      return new Response(JSON.stringify(updated), { status: 200 })
    }
    if (method === 'DELETE') {
      const id = url.split('/').pop()!
      db.delete(id)
      return new Response(null, { status: 204 })
    }
    throw new Error(`unhandled request: ${method} ${url}`)
  }) as unknown as typeof fetch

  return { fetchMock, calls, db }
}

describe('createTableCollection', () => {
  it('syncs initial rows from the table list endpoint', async () => {
    const { fetchMock } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      baseUrl: 'http://x/api',
      fetch: fetchMock,
      queryClient,
    })

    await collection.stateWhenReady()

    expect(collection.size).toBe(2)
    expect(collection.get('card_1')).toEqual({ id: 'card_1', title: 'A' })
  })

  it('onInsert calls table.create and the new row appears after refetch', async () => {
    const { fetchMock, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card, { title: string }>({
      tableName: 'cards',
      baseUrl: 'http://x/api',
      fetch: fetchMock,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.insert({ id: 'card_3', title: 'C' })
    await new Promise((r) => setTimeout(r, 10))

    const createCall = calls.find((c) => c.method === 'POST')
    expect(createCall?.body).toEqual({ title: 'C' })
  })

  it('onDelete calls table.delete with the row key', async () => {
    const { fetchMock, calls } = fetchMockFactory()
    const queryClient = new QueryClient()
    const { collection } = createTableCollection<Card>({
      tableName: 'cards',
      baseUrl: 'http://x/api',
      fetch: fetchMock,
      queryClient,
    })
    await collection.stateWhenReady()

    collection.delete('card_1')
    await new Promise((r) => setTimeout(r, 10))

    const deleteCall = calls.find((c) => c.method === 'DELETE')
    expect(deleteCall?.url.endsWith('/card_1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack-sync/src/collection.test.ts`
Expected: FAIL — `Cannot find module './collection'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/bunderstack-sync/src/collection.ts`:
```ts
import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import { createTableClient, type TableClient } from 'bunderstack-query'

export type TableCollectionConfig = {
  tableName: string
  baseUrl: string
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
  /** Rows per sync fetch. Defaults to 100. */
  limit?: number
}

export function createTableCollection<
  TRow extends { id: string | number },
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
>(config: TableCollectionConfig) {
  const table = createTableClient<TRow, TCreate, TUpdate>({
    tableName: config.tableName,
    baseUrl: config.baseUrl,
    fetch: config.fetch,
  })

  const collection = createCollection(
    queryCollectionOptions<TRow>({
      queryKey: [config.tableName, 'collection'],
      queryFn: async () => {
        const page = await table.list({ limit: config.limit ?? 100 })
        return page.items
      },
      queryClient: config.queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        const mutation = transaction.mutations[0]!
        await table.create(mutation.modified as unknown as Partial<TCreate>)
      },
      onUpdate: async ({ transaction }) => {
        const mutation = transaction.mutations[0]!
        await table.update(
          mutation.key as string | number,
          mutation.changes as unknown as TUpdate,
        )
      },
      onDelete: async ({ transaction }) => {
        const mutation = transaction.mutations[0]!
        await table.delete(mutation.key as string | number)
      },
    }),
  )

  return { collection, table: table as TableClient<TRow, TCreate, TUpdate> }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/bunderstack-sync/src/collection.test.ts`
Expected: `3 pass, 0 fail`

If `collection.stateWhenReady()` or `collection.size`/`collection.get`/`collection.insert`/`collection.delete` don't match the installed `@tanstack/react-db` version's actual API, run:
`bun pm view @tanstack/react-db@0.1.91 2>&1 | head -5` to confirm the version installed, then check `node_modules/@tanstack/react-db/dist/esm/*.d.ts` for the `Collection` class's actual method names (the ones above — `stateWhenReady`, `size`, `get`, `insert`, `delete` — are the standard TanStack DB collection API, but pin down the exact names against what's actually installed before assuming the test is wrong).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p packages/bunderstack-sync` (or, if no tsconfig was created in Task 2.1 Step 2, run `bunx tsc --noEmit --strict --esModuleInterop --moduleResolution bundler packages/bunderstack-sync/src/collection.ts`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack-sync/package.json packages/bunderstack-sync/src/collection.ts packages/bunderstack-sync/src/collection.test.ts
git commit -m "feat(bunderstack-sync): add createTableCollection

Wraps bunderstack-query's createTableClient in a TanStack DB query collection
— onInsert/onUpdate/onDelete delegate to the same REST primitives the
react-query bindings use, so mutation semantics stay identical across both
data layers."
```

(Include `tsconfig.json` in this commit too if Task 2.1 Step 2 created one.)

---

### Task 2.3: Realtime sync — surgical writes via `applyEvent`/`onGap`

**Files:**
- Create: `packages/bunderstack-sync/src/realtime-sync.ts`
- Test: `packages/bunderstack-sync/src/realtime-sync.test.ts`

**Interfaces:**
- Consumes: `createRealtimeClient` and `RealtimeEvent` from `bunderstack-query` (from Phase 1 — `createRealtimeClient(config: RealtimeClientConfig)` where `RealtimeClientConfig` now includes `applyEvent?: (evt: RealtimeEvent) => void` and `onGap?: () => void`). `Collection` instances produced by `createTableCollection` (Task 2.2) — specifically their `.utils.writeUpsert(item)`, `.utils.writeDelete(key)`, and `.utils.refetch()` methods (from `@tanstack/query-db-collection`'s documented `QueryCollectionUtils` interface).
- Produces:
```ts
export type SyncRealtimeConfig = {
  baseUrl: string
  queryClient: QueryClient
  fetch?: typeof fetch
  /** Map of table name -> the collection that table's rows sync into. */
  collections: Record<string, { utils: { writeUpsert: (item: unknown) => void; writeDelete: (key: unknown) => void; refetch: () => Promise<void> } }>
}

export function createSyncRealtimeClient(config: SyncRealtimeConfig): ReturnType<typeof createRealtimeClient>
```
  Later tasks (Phase 3) call this once with the full collection map and `.subscribe([...tableNames])`.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack-sync/src/realtime-sync.test.ts`:
```ts
import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createSyncRealtimeClient } from './realtime-sync'

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
    end: () => controller.close(),
  }
}

function fakeCollection() {
  const upserts: unknown[] = []
  const deletes: unknown[] = []
  let refetchCount = 0
  return {
    upserts,
    deletes,
    get refetchCount() {
      return refetchCount
    },
    utils: {
      writeUpsert: (item: unknown) => upserts.push(item),
      writeDelete: (key: unknown) => deletes.push(key),
      refetch: async () => {
        refetchCount++
      },
    },
  }
}

describe('createSyncRealtimeClient', () => {
  it('routes create/update events to writeUpsert on the matching collection', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: false }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts'])
    stream.push({
      eventId: 1,
      action: 'create',
      table: 'posts',
      record: { id: 'post_1', title: 'A' },
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.upserts).toEqual([{ id: 'post_1', title: 'A' }])
    rt.close()
  })

  it('routes delete events to writeDelete with the record id', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: false }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts'])
    stream.push({
      eventId: 1,
      action: 'delete',
      table: 'posts',
      record: { id: 'post_1' },
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.deletes).toEqual(['post_1'])
    rt.close()
  })

  it('refetches every collection on gap instead of patching individual records', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const users = fakeCollection()
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: true }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts, users },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts', 'users'])
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.refetchCount).toBe(1)
    expect(users.refetchCount).toBe(1)
    rt.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack-sync/src/realtime-sync.test.ts`
Expected: FAIL — `Cannot find module './realtime-sync'`.

- [ ] **Step 3: Write the implementation**

Create `packages/bunderstack-sync/src/realtime-sync.ts`:
```ts
import { createRealtimeClient, type RealtimeEvent } from 'bunderstack-query'
import type { QueryClient } from '@tanstack/react-query'

type SyncableCollection = {
  utils: {
    writeUpsert: (item: unknown) => void
    writeDelete: (key: unknown) => void
    refetch: () => Promise<void>
  }
}

export type SyncRealtimeConfig = {
  baseUrl: string
  queryClient: QueryClient
  fetch?: typeof fetch
  /** Map of table name -> the collection that table's rows sync into. */
  collections: Record<string, SyncableCollection>
}

export function createSyncRealtimeClient(config: SyncRealtimeConfig) {
  const tables = Object.keys(config.collections)

  return createRealtimeClient({
    baseUrl: config.baseUrl,
    queryClient: config.queryClient,
    tables,
    fetch: config.fetch,
    applyEvent: (evt: RealtimeEvent) => {
      const collection = config.collections[evt.table]
      if (!collection) return
      if (evt.action === 'delete') {
        collection.utils.writeDelete(evt.record['id'])
      } else {
        collection.utils.writeUpsert(evt.record)
      }
    },
    onGap: () => {
      for (const collection of Object.values(config.collections)) {
        void collection.utils.refetch()
      }
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/bunderstack-sync/src/realtime-sync.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p packages/bunderstack-sync` (or the same fallback flags as Task 2.2 Step 5)
Expected: no errors.

- [ ] **Step 6: Run the full bunderstack-sync suite**

Run: `bun test packages/bunderstack-sync`
Expected: `6 pass, 0 fail` (3 from Task 2.2 + 3 from this task).

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack-sync/src/realtime-sync.ts packages/bunderstack-sync/src/realtime-sync.test.ts
git commit -m "feat(bunderstack-sync): wire SSE realtime events to direct collection writes

createSyncRealtimeClient reuses bunderstack-query's realtime client (reconnect/
backoff/watchdog/gap-recovery) via the new applyEvent/onGap hooks, routing
create/update to collection.utils.writeUpsert and delete to writeDelete —
one record patched per event, no list invalidation or refetch storm."
```

---

### Task 2.4: Public API — `createBunderstackSyncClient`

**Files:**
- Create: `packages/bunderstack-sync/src/index.ts`
- Test: `packages/bunderstack-sync/src/index.test.ts`

**Interfaces:**
- Consumes: `createTableCollection` (Task 2.2), `createSyncRealtimeClient` (Task 2.3), `createBucketClient` and `attachBucketMutationOptions` from `bunderstack-query` (for the `.files` surface — same as `bunderstack-query`'s own `withFiles`/`with` implementation; read `packages/bunderstack-query/src/index.ts`'s `withFiles` method, lines ~133-154, before writing this — copy its bucket-loop logic verbatim, do not reinvent it).
- Produces:
```ts
export function createBunderstackSyncClient<TSchema extends Record<string, unknown> = Record<string, unknown>>(): {
  with<const TTables extends readonly (keyof TSchema & string)[], const TBuckets extends readonly string[]>(
    options: {
      queryClient: QueryClient
      fetch?: typeof fetch
      baseUrl?: string
      tables: TTables
      buckets: TBuckets
      /** Subscribe these tables to live SSE updates. Defaults to true (all tables). */
      realtime?: boolean
    },
  ): {
    [K in TTables[number]]: { collection: Collection<...>, table: TableClient<...> }
  } & {
    files: { [K in TBuckets[number]]: BucketClient & BucketMutationOptions }
  } & {
    /** Present only when realtime is enabled. Call .subscribe([...tables]) once auth/session is known, .close() on unmount. */
    realtime?: ReturnType<typeof createSyncRealtimeClient>
  }
}
```
  This is the only entry point Phase 3+ uses — no other `bunderstack-sync` export is consumed directly by the example except (optionally) the individual `createTableCollection`/`createSyncRealtimeClient` functions for advanced/custom use (re-exported for that "Level 2" escape hatch, matching `bunderstack-query`'s philosophy).

- [ ] **Step 1: Read `bunderstack-query`'s `with`/`withFiles` implementation to copy the bucket-loop logic exactly**

Run: `sed -n '133,202p' packages/bunderstack-query/src/index.ts`

Note the exact shape of the loop that builds `client.files[bucket]` — you will copy this pattern into the new file in Step 3.

- [ ] **Step 2: Write the failing test**

Create `packages/bunderstack-sync/src/index.test.ts`:
```ts
import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createBunderstackSyncClient } from './index'

type Schema = {
  posts: unknown
  user: unknown
}

function fetchMockFactory() {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/posts')) {
      return new Response(JSON.stringify({ items: [], limit: 100, hasMore: false }), { status: 200 })
    }
    if (url.includes('/user')) {
      return new Response(JSON.stringify({ items: [], limit: 100, hasMore: false }), { status: 200 })
    }
    throw new Error(`unhandled request: ${url}`)
  }) as unknown as typeof fetch
}

describe('createBunderstackSyncClient', () => {
  it('builds one collection per table and a files surface per bucket', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts', 'user'] as const,
      buckets: ['attachments'] as const,
      realtime: false,
    })

    expect(api.posts.collection).toBeDefined()
    expect(api.user.collection).toBeDefined()
    expect(api.files.attachments.upload).toBeDefined()
    expect(api.files.attachments.url).toBeDefined()
    expect(api.realtime).toBeUndefined()
  })

  it('exposes a realtime client when realtime is true (default)', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts'] as const,
      buckets: [] as const,
    })

    expect(api.realtime).toBeDefined()
    api.realtime!.close()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/bunderstack-sync/src/index.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 4: Write the implementation**

Create `packages/bunderstack-sync/src/index.ts`. Replace `<PASTE BUCKET LOOP FROM index.ts STEP 1>` below with the exact bucket-building logic you read in Step 1 (it loops `options.buckets`, calls `createBucketClient`, spreads in `attachBucketMutationOptions`, and assigns into a `files` object — copy it verbatim, only renaming local variables if they'd collide):
```ts
import type { QueryClient } from '@tanstack/react-query'
import {
  createBucketClient,
  attachBucketMutationOptions,
  type FilesQueryClient,
} from 'bunderstack-query'

import { createTableCollection } from './collection'
import { createSyncRealtimeClient } from './realtime-sync'

type BaseOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
}

export function createBunderstackSyncClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>() {
  return {
    with<
      const TTables extends readonly (keyof TSchema & string)[],
      const TBuckets extends readonly string[],
    >(
      options: BaseOptions & {
        tables: TTables
        buckets: TBuckets
        /** Subscribe these tables to live SSE updates. Defaults to true. */
        realtime?: boolean
      },
    ) {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)

      const tablesClient: Record<
        string,
        ReturnType<typeof createTableCollection>
      > = {}
      for (const tableKey of options.tables) {
        tablesClient[tableKey] = createTableCollection({
          tableName: tableKey,
          baseUrl,
          fetch: fetchFn,
          queryClient: options.queryClient,
        })
      }

      // <PASTE BUCKET LOOP FROM index.ts STEP 1>
      const filesClient: FilesQueryClient<TBuckets[number]> = {
        files: {} as FilesQueryClient<TBuckets[number]>['files'],
      }
      for (const bucket of options.buckets) {
        const bucketClient = createBucketClient({
          bucket,
          baseUrl,
          fetch: fetchFn,
        })
        filesClient.files[bucket as TBuckets[number]] = {
          ...bucketClient,
          ...attachBucketMutationOptions(bucketClient, options.queryClient),
        }
      }

      const realtime =
        options.realtime === false
          ? undefined
          : createSyncRealtimeClient({
              baseUrl,
              queryClient: options.queryClient,
              fetch: fetchFn,
              collections: Object.fromEntries(
                Object.entries(tablesClient).map(([k, v]) => [
                  k,
                  v.collection,
                ]),
              ),
            })

      return {
        ...tablesClient,
        ...filesClient,
        realtime,
      } as {
        [K in TTables[number]]: ReturnType<typeof createTableCollection>
      } & FilesQueryClient<TBuckets[number]> & {
          realtime: typeof realtime
        }
    },
  }
}

export { createTableCollection } from './collection'
export type { TableCollectionConfig } from './collection'
export { createSyncRealtimeClient } from './realtime-sync'
export type { SyncRealtimeConfig } from './realtime-sync'
```

(If Step 1's actual bucket loop differs in variable names from the placeholder shown here, use what you actually read — the placeholder above is a best-effort reconstruction; the real file is the source of truth.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/bunderstack-sync/src/index.test.ts`
Expected: `2 pass, 0 fail`

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit -p packages/bunderstack-sync` (or fallback flags as before)
Expected: no errors. If the `as { ... }` cast at the end of `with()` doesn't satisfy the compiler, loosen it to `as any as (...)` with the same target type — this mirrors the level of type-assertion `bunderstack-query`'s own `with()` already uses for the same reason (heterogeneous map construction via a loop can't be statically tracked per-key).

- [ ] **Step 7: Run the full bunderstack-sync suite**

Run: `bun test packages/bunderstack-sync`
Expected: `8 pass, 0 fail` (6 from Tasks 2.2/2.3 + 2 from this task).

- [ ] **Step 8: Add bunderstack-sync to the root test script**

In root `package.json`, change:
```json
"test": "bun test --cwd packages/bunderstack && bun test --cwd packages/bunderstack-query",
```
to:
```json
"test": "bun test --cwd packages/bunderstack && bun test --cwd packages/bunderstack-query && bun test --cwd packages/bunderstack-sync",
```

- [ ] **Step 9: Run the root test script to confirm full-repo wiring**

Run: `cd /Users/kirill/pet-projects/bunderstack && bun run test`
Expected: all three package suites pass.

- [ ] **Step 10: Commit**

```bash
git add packages/bunderstack-sync/src/index.ts packages/bunderstack-sync/src/index.test.ts package.json
git commit -m "feat(bunderstack-sync): add createBunderstackSyncClient public API

Mirrors bunderstack-query's createBunderstackQueryClient().with({...}) shape:
one function call turns a table/bucket list into TanStack DB collections,
a files surface, and a live realtime connection (opt out with realtime: false)."
```

---

## Phase 3 — Example scaffold

### Task 3.1: Copy and rename

**Files:**
- Create: `examples/twitter-db-tanstack/` (copied from `examples/twitter-tanstack/`)

- [ ] **Step 1: Copy, excluding generated/runtime artifacts**

```bash
cd /Users/kirill/pet-projects/bunderstack
rsync -a --exclude node_modules --exclude .nitro --exclude .output \
  --exclude data.db --exclude uploads --exclude .env \
  examples/twitter-tanstack/ examples/twitter-db-tanstack/
```

- [ ] **Step 2: Verify the copy**

Run: `ls examples/twitter-db-tanstack/src && ls examples/twitter-db-tanstack/`
Expected: same directory structure as `examples/twitter-tanstack` (minus the excluded paths).

- [ ] **Step 3: Rename the package**

In `examples/twitter-db-tanstack/package.json`, change:
```json
"name": "bunderstack-example-twitter-tanstack",
```
to:
```json
"name": "bunderstack-example-twitter-db-tanstack",
```

- [ ] **Step 4: Regenerate `.env` from `.env.example`**

Run: `cp examples/twitter-tanstack/.env.example examples/twitter-db-tanstack/.env`

Edit `examples/twitter-db-tanstack/.env` and change any port-3000 references (e.g. `APP_URL`, `BETTER_AUTH_URL`) to port 3003. Check the file's actual contents first:

Run: `cat examples/twitter-db-tanstack/.env`

Then edit accordingly (the exact variable names depend on what's in `.env.example` — read it before editing rather than guessing).

- [ ] **Step 5: Commit**

```bash
git add examples/twitter-db-tanstack
git commit -m "chore(twitter-db-tanstack): scaffold example from twitter-tanstack copy

Starting point for the TanStack DB + shadcn/ui rewrite — backend (schema,
access rules, auth config) carries over unchanged; data and UI layers are
replaced in subsequent commits."
```

(`.env` is gitignored per `examples/twitter-tanstack/.gitignore`, copied along with the directory — confirm with `git status` that it's not staged before committing; if it is staged, something's wrong with the copied `.gitignore`, stop and investigate rather than force-add it.)

---

### Task 3.2: Swap dependencies — remove oat/react-query data hooks, add bunderstack-sync/Tailwind/shadcn deps

**Files:**
- Modify: `examples/twitter-db-tanstack/package.json`

- [ ] **Step 1: Read the current dependencies**

Run: `cat examples/twitter-db-tanstack/package.json`

- [ ] **Step 2: Edit `dependencies`**

Remove: `"@knadh/oat": "^0.6.2"`

Add (alongside the existing `@tanstack/react-query` — it stays, `@tanstack/query-db-collection` needs a real `QueryClient` underneath):
```json
"bunderstack-sync": "workspace:*",
"@tanstack/react-db": "^0.1.91",
"@tanstack/query-db-collection": "^1.0.45",
"tailwindcss": "^4.0.0",
"@tailwindcss/vite": "^4.0.0",
"class-variance-authority": "^0.7.1",
"clsx": "^2.1.1",
"tailwind-merge": "^3.0.0",
"lucide-react": "^0.475.0",
"sonner": "^1.7.4",
"@radix-ui/react-slot": "^1.1.2",
"@radix-ui/react-dialog": "^1.1.6",
"@radix-ui/react-tabs": "^1.1.3",
"@radix-ui/react-avatar": "^1.1.3"
```

Remove `bunderstack-query` from `dependencies` if it's listed directly (the example should now depend on `bunderstack-sync` only — `bunderstack-sync` pulls in `bunderstack-query` as its own workspace dependency).

- [ ] **Step 3: Install**

Run: `cd /Users/kirill/pet-projects/bunderstack && bun install`
Expected: exits 0.

- [ ] **Step 4: Verify removed/added packages**

Run: `ls node_modules/.bun | grep -i 'knadh' || echo "oat removed, good"`
Run: `ls node_modules | grep -E 'bunderstack-sync|tailwindcss'`
Expected: oat not found; `bunderstack-sync` symlink and `tailwindcss` present.

- [ ] **Step 5: Commit**

```bash
git add examples/twitter-db-tanstack/package.json
git commit -m "chore(twitter-db-tanstack): swap oat for bunderstack-sync + Tailwind/shadcn deps"
```

---

### Task 3.3: Tailwind v4 + shadcn foundation

**Files:**
- Modify: `examples/twitter-db-tanstack/vite.config.ts`
- Modify: `examples/twitter-db-tanstack/src/styles/app.css` (replace entirely)
- Create: `examples/twitter-db-tanstack/components.json`
- Create: `examples/twitter-db-tanstack/src/lib/utils.ts`
- Delete: `examples/twitter-db-tanstack/src/utils/oat.ts`
- Delete: `examples/twitter-db-tanstack/src/components/OatInit.tsx`

- [ ] **Step 1: Add the Tailwind Vite plugin**

In `examples/twitter-db-tanstack/vite.config.ts`, add the import:
```ts
import tailwindcss from '@tailwindcss/vite'
```
and add `tailwindcss()` to the `plugins` array (alongside the existing `bunderstackApiDevMiddleware()`, `devtools()`, `tanstackStart(...)`, `viteReact()`, `nitro(...)`).

- [ ] **Step 2: Replace `app.css` with Tailwind + a base theme**

Replace the full contents of `examples/twitter-db-tanstack/src/styles/app.css` with:
```css
@import "tailwindcss";

@theme {
  --font-sans: ui-sans-serif, system-ui, sans-serif;
}

:root {
  color-scheme: light dark;
}

body {
  @apply bg-background text-foreground;
}
```

(This intentionally drops every oat-era class — `.card`, `.outline`, `.post-x`, etc. Phase 5 tasks replace each usage with Tailwind utility classes + shadcn components as each component is ported. Until Phase 5 finishes, pages will look unstyled; that's expected mid-migration, not a bug to fix now.)

- [ ] **Step 3: Delete oat-specific files**

```bash
rm examples/twitter-db-tanstack/src/utils/oat.ts
rm examples/twitter-db-tanstack/src/components/OatInit.tsx
```

- [ ] **Step 4: Create `components.json`** (shadcn CLI config — written by hand so this plan stays deterministic rather than depending on an interactive wizard's prompts)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/app.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "~/components",
    "utils": "~/lib/utils",
    "ui": "~/components/ui",
    "lib": "~/lib",
    "hooks": "~/hooks"
  }
}
```

- [ ] **Step 5: Create the `cn()` utility shadcn components depend on**

Create `examples/twitter-db-tanstack/src/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 6: Try running the shadcn CLI to add the base theme CSS variables** (best-effort — if it prompts interactively in a way that can't be scripted, skip to Step 7's manual fallback)

Run: `cd examples/twitter-db-tanstack && bunx --bun shadcn@latest add button --yes 2>&1 | head -30`

If this succeeds, it will have appended shadcn's CSS variable theme block (`--background`, `--foreground`, etc.) to `src/styles/app.css` and created `src/components/ui/button.tsx`. Skip Step 7.

- [ ] **Step 7: Manual fallback — if Step 6 failed or hung (no TTY for interactive prompts)**

Append shadcn's standard "new-york" + "neutral" CSS variable block to `examples/twitter-db-tanstack/src/styles/app.css` (after the `@theme` block from Step 2):
```css
@layer base {
  :root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.145 0 0);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.145 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.97 0 0);
    --secondary-foreground: oklch(0.205 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --accent: oklch(0.97 0 0);
    --accent-foreground: oklch(0.205 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.922 0 0);
    --input: oklch(0.922 0 0);
    --ring: oklch(0.708 0 0);
    --radius: 0.625rem;
  }
  .dark {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
  }
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

If you also skipped Step 6's CLI run, manually create `examples/twitter-db-tanstack/src/components/ui/button.tsx` with shadcn's standard New York-style Button component (`buttonVariants` via `class-variance-authority`, `Slot` from `@radix-ui/react-slot` for `asChild` support) — this is well-known, stable, public source; do not invent a different shape.

- [ ] **Step 8: Typecheck**

Run: `bunx tsc --noEmit -p examples/twitter-db-tanstack 2>&1 | head -60`
Expected: errors from the now-missing `oat.ts`/`OatInit.tsx` imports in `__root.tsx` and every component that imported `~/utils/oat` — this is **expected** at this point in the migration (Phase 5 fixes each one as it ports that file). Confirm the errors are *only* about missing oat imports/usages, not something else (e.g. a typo in this task's new files) — read through the error list before moving on.

- [ ] **Step 9: Commit**

```bash
git add examples/twitter-db-tanstack/vite.config.ts examples/twitter-db-tanstack/src/styles/app.css examples/twitter-db-tanstack/components.json examples/twitter-db-tanstack/src/lib/utils.ts
git rm examples/twitter-db-tanstack/src/utils/oat.ts examples/twitter-db-tanstack/src/components/OatInit.tsx
git commit -m "chore(twitter-db-tanstack): add Tailwind v4 + shadcn foundation, remove oat

App-wide styling now starts from Tailwind + shadcn's default theme. Existing
components still reference the removed oat module — that's expected and
fixed file-by-file in Phase 5, not all at once here."
```

---

### Task 3.4: Enable realtime on the backend

**Files:**
- Modify: `examples/twitter-db-tanstack/src/bunderstack.ts`

- [ ] **Step 1: Read the current config**

Run: `cat examples/twitter-db-tanstack/src/bunderstack.ts`

- [ ] **Step 2: Add `realtime: true`**

Add `realtime: true` as a top-level key in the `createBunderstack({...})` call (alongside `schema`, `access`, `database`, `auth`, `storage`).

- [ ] **Step 3: Verify the realtime router gets mounted**

Run: `cd examples/twitter-db-tanstack && bun --bun vite dev --port 3003 > /tmp/twitter-db-dev.log 2>&1 &`
Run: `sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" -H "Accept: text/event-stream" --max-time 2 http://localhost:3003/api/realtime`

Expected: `200` (the connection will be held open by the SSE stream — `--max-time 2` cuts it off after 2 seconds, that's fine, we're only checking the response started with a 200).

If you get `404`, the realtime router isn't mounted — check whether `examples/twitter-db-tanstack/vite.config.ts`'s `bunderstackApiDevMiddleware` (or, in other examples, the framework's own route handler) needs the realtime router added explicitly. Compare against how `examples/kanban-tanstack` or any example with realtime already wired mounts it (run `grep -rln "realtimeRouter\|buildRealtimeRouter" examples/*/src 2>/dev/null` to find one, if any exist — if none do, this is the first, and the router is mounted automatically by `app.handler` once `realtime: true` is set, per `packages/bunderstack/src/handler.ts:36-37` (`if (parts.realtimeRouter) app.route('/api', parts.realtimeRouter)`) — no example-level wiring should be needed beyond the config flag).

- [ ] **Step 4: Stop the dev server**

Run: `pkill -f "vite dev --port 3003"`

- [ ] **Step 5: Commit**

```bash
git add examples/twitter-db-tanstack/src/bunderstack.ts
git commit -m "feat(twitter-db-tanstack): enable realtime broker"
```

---

## Phase 4 — Data layer

### Task 4.1: `collections.ts` — replaces `api-client.ts`

**Files:**
- Create: `examples/twitter-db-tanstack/src/collections.ts`
- Delete: `examples/twitter-db-tanstack/src/api-client.ts`

**Interfaces:**
- Consumes: `createBunderstackSyncClient` from `bunderstack-sync` (Task 2.4).
- Produces:
```ts
export function createQueryClient(): QueryClient
export function createSyncApi(queryClient: QueryClient): SyncApi  // SyncApi = return type of .with({...})
export type SyncApi = ReturnType<typeof createSyncApi>
```
  Same two-function shape as the old `api-client.ts`'s `createQueryClient`/`createApi`, so `router.tsx` (Task 4.2) needs minimal changes — same per-request-instance pattern that fixed the SSR singleton-leak bug earlier this session.

- [ ] **Step 1: Read the file being replaced**

Run: `cat examples/twitter-db-tanstack/src/api-client.ts`

- [ ] **Step 2: Write `collections.ts`**

```ts
import { QueryClient } from '@tanstack/react-query'
import { createBunderstackSyncClient } from 'bunderstack-sync'
import { createIsomorphicFn } from '@tanstack/react-start'

import type * as schema from './schema'

/** Bun/Node fetch requires absolute URLs during SSR; the browser accepts `/api/...`. */
const isomorphicFetch = createIsomorphicFn()
  .client((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  .server(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      let origin: string
      try {
        const { getRequest } = await import('@tanstack/react-start/server')
        origin = new URL(getRequest().url).origin
      } catch {
        origin =
          process.env.APP_URL ??
          process.env.BETTER_AUTH_URL ??
          'http://localhost:3003'
      }
      return fetch(new URL(input, origin), init)
    }
    return fetch(input, init)
  })

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
}

export function createSyncApi(queryClient: QueryClient) {
  return createBunderstackSyncClient<typeof schema>().with({
    queryClient,
    fetch: isomorphicFetch,
    tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
    buckets: ['attachments', 'avatars'] as const,
    // Realtime needs a browser-side persistent connection; skip it during SSR.
    realtime: typeof window !== 'undefined',
  })
}

export type SyncApi = ReturnType<typeof createSyncApi>
```

- [ ] **Step 3: Delete the old file**

```bash
rm examples/twitter-db-tanstack/src/api-client.ts
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p examples/twitter-db-tanstack 2>&1 | head -60`
Expected: new errors in every file that imported `~/api-client` — expected, fixed file-by-file starting next task.

- [ ] **Step 5: Commit**

```bash
git add examples/twitter-db-tanstack/src/collections.ts
git rm examples/twitter-db-tanstack/src/api-client.ts
git commit -m "feat(twitter-db-tanstack): add collections.ts on bunderstack-sync, remove api-client.ts"
```

---

### Task 4.2: `router.tsx` + `__root.tsx` — wire collections into router context, validate pagination strategy

**Files:**
- Modify: `examples/twitter-db-tanstack/src/router.tsx`
- Modify: `examples/twitter-db-tanstack/src/routes/__root.tsx`

**Interfaces:**
- Consumes: `createQueryClient`/`createSyncApi`/`SyncApi` (Task 4.1).
- Produces: `RouterContext` with `{ queryClient: QueryClient; api: SyncApi; user: ... | null }` (same shape as `twitter-tanstack`'s `RouterContext`, `api`'s type changed).

- [ ] **Step 1: Read the current `router.tsx` and `__root.tsx`**

Run: `cat examples/twitter-db-tanstack/src/router.tsx examples/twitter-db-tanstack/src/routes/__root.tsx`

- [ ] **Step 2: Update `router.tsx`**

Replace the `createApi`/`createQueryClient`/`AppApi` import and usage with `createSyncApi`/`createQueryClient`/`SyncApi` from `~/collections`. Remove the `setupRouterSsrQueryIntegration` call and its import (`@tanstack/react-router-ssr-query`) — TanStack DB collections sync independently of react-query's SSR dehydration mechanism; there is no equivalent step needed here. `RouterContext.api`'s type changes from `AppApi` to `SyncApi`.

The resulting `getRouter()` should still:
- Call `createQueryClient()` and `createSyncApi(queryClient)` once per router instance (per-request on the server, once on the client) — same pattern as before, for the same reason (no cross-request data leak).
- Pass `{ queryClient, api, user: null }` as router context.
- No longer call `setupRouterSsrQueryIntegration`.

- [ ] **Step 3: Update `__root.tsx`**

Remove the `QueryClientProvider` wrapping (`@tanstack/react-query`'s provider isn't needed for rendering — TanStack DB collections don't require a context provider the way react-query hooks do; `useLiveQuery` reads directly from the collection instance passed to it, no provider lookup involved). Remove the `<ClientOnly><OatInit /></ClientOnly>` block (oat is gone — deleted in Task 3.3).

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p examples/twitter-db-tanstack 2>&1 | head -60`
Expected: errors should now only come from route/component files not yet ported (Phase 5) — `router.tsx` and `__root.tsx` themselves should be clean.

- [ ] **Step 5: Commit**

```bash
git add examples/twitter-db-tanstack/src/router.tsx examples/twitter-db-tanstack/src/routes/__root.tsx
git commit -m "feat(twitter-db-tanstack): wire collections into router context"
```

---

### Task 4.3: Feed page — posts collection + pagination strategy validation (GATING TASK)

**Files:**
- Modify: `examples/twitter-db-tanstack/src/routes/index.tsx`

**Interfaces:**
- Consumes: `api.posts.collection` (a `Collection<Post>` from Task 4.1's `SyncApi`), `useLiveQuery`/`useLiveInfiniteQuery` from `@tanstack/react-db`.
- Produces: a working `/` feed route. This task's main job is answering the open question from the design doc: **does paginating via `useLiveInfiniteQuery` keep the underlying HTTP fetch bounded, or does it require the base collection to already hold the full table?** Everything in Phase 5 that uses pagination depends on the answer.

- [ ] **Step 1: Read `examples/twitter-tanstack/src/routes/index.tsx` in full** — this is the reference implementation for feature behavior (tabs, compose trigger, suggestions sidebar, post list). Do not redesign the page's behavior, only its data/UI plumbing.

- [ ] **Step 2: Write a minimal version using `useLiveQuery` directly (no infinite scroll yet) to prove the basic join works**

In `examples/twitter-db-tanstack/src/routes/index.tsx`, write a component that:
```tsx
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: FeedPage,
})

function FeedPage() {
  const { api } = Route.useRouteContext()
  const { data: posts } = useLiveQuery((q) =>
    q
      .from({ post: api.posts.collection })
      .join({ author: api.user.collection }, ({ post, author }) =>
        eq(author.id, post.userId),
      )
      .where(({ post }) => eq(post.replyToId, null))
      .orderBy(({ post }) => post.createdAt, 'desc')
      .select(({ post, author }) => ({
        id: post.id,
        body: post.body,
        createdAt: post.createdAt,
        authorName: author.name,
      })),
  )

  return (
    <div>
      {(posts ?? []).map((p) => (
        <article key={p.id}>
          <strong>{p.authorName}</strong>
          <p>{p.body}</p>
        </article>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Run the dev server and the stress-seed script against this example's db**

```bash
cd examples/twitter-db-tanstack
bun run db:push
bun run seed
(bun --bun vite dev --port 3003 > /tmp/twitter-db-dev.log 2>&1 &)
sleep 4
curl -s -o /tmp/feed-step3.html -w "HTTP %{http_code}\n" "http://localhost:3003/"
grep -ao 'article' /tmp/feed-step3.html | wc -l
```
Expected: `HTTP 200`, and at least 1 `article` tag (the seeded posts render with real author names, proving the join works end to end).

- [ ] **Step 4: Stress-test and inspect actual network behavior**

```bash
cd examples/twitter-db-tanstack
bun scripts/stress-seed.ts --users=2000 --posts=20000 --replies=5000 --follows=10000 --likes=40000 --retweets=10000
```

(If `scripts/stress-seed.ts` references `~/bunderstack` and `~/schema` the same way it did in `twitter-tanstack`, it should work unchanged — it was copied in Task 3.1. Confirm by reading it: `cat examples/twitter-db-tanstack/scripts/stress-seed.ts | head -20`.)

Then, with the dev server running, fetch the homepage and time it, and check the actual HTTP request the browser would make for the *initial* posts collection sync:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}, %{time_total}s\n" "http://localhost:3003/"
curl -s "http://localhost:3003/api/posts?limit=100" | bun -e "const d = JSON.parse(await Bun.stdin.text()); console.log('items returned:', d.items.length, 'of', await (await fetch('http://localhost:3003/api/posts?count=true&limit=1')).json().then(r => r.total))"
```

**Decision point:**
- If the page loads fast (well under 1s) and the network tab / curl timing shows only ~100 rows fetched for the initial collection sync (not all 25,000) — the `limit` passed to `createTableCollection` (Task 2.2, defaults to 100) is already doing its job as a bound, and `useLiveInfiniteQuery`'s `setWindow()` windows *within* that synced set. **This means the posts collection as built only ever shows the first ~100 posts by whatever order `table.list()` returns them in** (not true infinite scroll past 100) — note this finding, it's the actual behavior, and Step 5 below documents the fallback needed to get real infinite scroll past row 100.
- Either way, do **not** assume `useLiveInfiniteQuery` will transparently page an arbitrarily large table — confirm what actually happened from this test before writing Step 5.

- [ ] **Step 5: Implement bounded infinite scroll for the posts collection specifically**

Based on Step 4's finding, the posts collection needs a *growing* `limit`, re-synced as the user scrolls — not the default fixed `limit: 100` from `createTableCollection`. Add a dedicated collection for posts (separate from the generic `api.posts.collection` used for single-post lookups elsewhere) that takes a reactive page count:

In `examples/twitter-db-tanstack/src/collections.ts`, add:
```ts
import { createTableCollection } from 'bunderstack-sync'

export function createFeedPostsCollection(
  queryClient: QueryClient,
  fetchFn: typeof fetch,
  pageCount: number,
) {
  return createTableCollection<schema.PostRow>({
    tableName: 'posts',
    baseUrl: '/api',
    fetch: fetchFn,
    queryClient,
    limit: pageCount * 20,
  }).collection
}
```

(Adjust `schema.PostRow` to whatever the actual exported row type is — check `examples/twitter-db-tanstack/src/schema.ts` for the Drizzle-inferred type name in use elsewhere, e.g. `InferSelect<typeof posts>` from `bunderstack-query`, and use that instead if `PostRow` doesn't exist.)

In `index.tsx`'s `FeedPage`, hold `pageCount` in `useState(1)`, recreate the feed-posts collection via `useMemo` keyed on `pageCount` (a NEW collection instance per page count — this re-fetches with a larger `limit` each time, trading some redundant refetching for correctness and simplicity; note this as a known v1 tradeoff, not a bug), and increment `pageCount` from the existing `LoadMore` component (ported in Phase 5, Task 5.x) the same way `fetchNextPage` was wired in `twitter-tanstack`.

- [ ] **Step 6: Re-run the stress check against the fixed implementation**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" "http://localhost:3003/"
```
Expected: `200`, and scrolling (simulated by bumping `pageCount` and re-fetching) reveals posts beyond row 100 — confirm by checking that a post known to be outside the first 100 (e.g. query the db directly for a post's `createdAt` far down the sort order, same technique used earlier this session to find "the busiest thread") appears once `pageCount` is large enough.

- [ ] **Step 7: Stop the dev server, typecheck**

```bash
pkill -f "vite dev --port 3003"
```
Run: `bunx tsc --noEmit -p examples/twitter-db-tanstack 2>&1 | head -60`

- [ ] **Step 8: Commit**

```bash
git add examples/twitter-db-tanstack/src/routes/index.tsx examples/twitter-db-tanstack/src/collections.ts
git commit -m "feat(twitter-db-tanstack): feed page on TanStack DB collections + bounded pagination

useLiveQuery replaces authorMap for the author join. Posts pagination uses a
growing-limit collection (re-synced per page) rather than relying on
useLiveInfiniteQuery to page an already-fully-synced collection — verified
against the 25k-post stress dataset that this keeps the initial fetch bounded."
```

---

## Phase 5 — Remaining routes and components

Each task below ports one file (or a small tightly-coupled group) from `examples/twitter-tanstack` to `examples/twitter-db-tanstack`, replacing:
- `useApi()` / `Route.useRouteContext().api` + `useQuery`/`useMutation`/`useInfiniteQuery` → `Route.useRouteContext().api` (now a `SyncApi`) + `useLiveQuery` + direct `collection.insert/update/delete` calls (TanStack DB's optimistic mutation API — replaces `*Mutation` helpers).
- oat's `toast`/`showDialog`/`closeDialog`/native `<dialog>` → `sonner`'s `toast` + shadcn `Dialog`/`AlertDialog`.
- oat-era CSS classes (`.card`, `.outline`, `.post-x`, etc.) → Tailwind utility classes + shadcn components (`Card`, `Button`, `Avatar`, etc.).

For each task: read the referenced `twitter-tanstack` file first, port its JSX structure and behavior, swap the substitutions above, typecheck, manually verify via curl against the dev server (same pattern as every verification this session — fetch the route, grep for expected content markers), then commit.

### Task 5.1: `NotFound`, `DefaultCatchBoundary`, `AppDevtools` — no data/oat dependencies, port as-is with Tailwind classes

**Files:**
- Modify: `examples/twitter-db-tanstack/src/components/NotFound.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/DefaultCatchBoundary.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/AppDevtools.tsx`

- [ ] Read each file in `examples/twitter-tanstack/src/components/`. Replace any oat CSS classes with Tailwind equivalents (e.g. button styling via `Button` from `~/components/ui/button`). These three files don't touch the data layer — straightforward port.
- [ ] Typecheck: `bunx tsc --noEmit -p examples/twitter-db-tanstack 2>&1 | grep -E "NotFound|DefaultCatchBoundary|AppDevtools"` — expect no output (no errors referencing these files).
- [ ] Commit: `git add examples/twitter-db-tanstack/src/components/NotFound.tsx examples/twitter-db-tanstack/src/components/DefaultCatchBoundary.tsx examples/twitter-db-tanstack/src/components/AppDevtools.tsx && git commit -m "feat(twitter-db-tanstack): port NotFound/DefaultCatchBoundary/AppDevtools to Tailwind"`

### Task 5.2: `UserAvatar`, `PostTime` — small, no data dependencies

**Files:**
- Modify: `examples/twitter-db-tanstack/src/components/UserAvatar.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/PostTime.tsx`

- [ ] Port `UserAvatar.tsx` using shadcn's `Avatar`/`AvatarImage`/`AvatarFallback` (`~/components/ui/avatar`) instead of the current hand-rolled `<img>`. `PostTime.tsx` has no UI-library dependency — port unchanged except any oat class names.
- [ ] Typecheck and commit, same pattern as Task 5.1.

### Task 5.3: `useToastMutation` → delete; sonner toast helpers

**Files:**
- Delete: `examples/twitter-db-tanstack/src/hooks/useToastMutation.ts`
- Create: `examples/twitter-db-tanstack/src/lib/toast.ts`

**Interfaces:**
- Produces: `import { toast } from '~/lib/toast'` — a thin re-export of `sonner`'s `toast`, with `toast.success`/`toast.error`/`toast.warning` matching oat's call shape closely enough that Phase 5's remaining tasks can swap the import with minimal changes (`sonner`'s API is already `toast.success(message)`/`toast.error(message)` — no wrapper logic needed beyond the re-export).

- [ ] **Step 1:** `useToastMutation.ts` doesn't port — TanStack DB's optimistic mutations (`collection.insert/update/delete`) handle the pending/error state differently (the mutation is applied optimistically immediately; errors roll back automatically). Each component that used `useToastMutation` gets toast calls added directly around its `collection.insert/update/delete` call in its own task (5.4+), with a `try/catch` for the error toast.
- [ ] **Step 2:** Create `examples/twitter-db-tanstack/src/lib/toast.ts`:
```ts
export { toast } from 'sonner'
```
- [ ] **Step 3:** Delete `examples/twitter-db-tanstack/src/hooks/useToastMutation.ts`.
- [ ] **Step 4:** Add the `<Toaster />` component (sonner's root) to `__root.tsx`'s `RootDocument`, inside `<body>`:
```tsx
import { Toaster } from '~/components/ui/sonner'
// ...
<Toaster />
```
Create `examples/twitter-db-tanstack/src/components/ui/sonner.tsx` with shadcn's standard `Toaster` wrapper (re-exports `sonner`'s `Toaster` with theme wiring — well-known, stable shape, don't invent a different one):
```tsx
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
```
- [ ] **Step 5:** Typecheck (expect `useToastMutation` import errors in not-yet-ported files — fine, fixed as each is ported).
- [ ] **Step 6:** Commit: `git add examples/twitter-db-tanstack/src/lib/toast.ts examples/twitter-db-tanstack/src/components/ui/sonner.tsx examples/twitter-db-tanstack/src/routes/__root.tsx && git rm examples/twitter-db-tanstack/src/hooks/useToastMutation.ts && git commit -m "feat(twitter-db-tanstack): add sonner toast + Toaster, remove useToastMutation"`

### Task 5.4: `FollowButton`

**Files:** Modify `examples/twitter-db-tanstack/src/components/FollowButton.tsx`

- [ ] Read `examples/twitter-tanstack/src/components/FollowButton.tsx`. Port using `Route.useRouteContext()`'s `api.follows.collection` — `existing` lookup stays the same client-side `.find()` logic over the `follows` prop array (unchanged — this component already receives a pre-scoped array, no collection query needed inside it). Replace `followMutation`/`unfollowMutation` (`useToastMutation` + `api.follows.createMutation`/`deleteMutation`) with:
```tsx
async function handleFollow() {
  try {
    api.follows.collection.insert({ id: generateTempId(), followerId: currentUserId, followingId: targetUserId })
    toast.success('Following')
  } catch {
    toast.error('Could not follow')
  }
}
```
(Use whatever temp-id generation TanStack DB's optimistic insert expects — check `@tanstack/react-db`'s docs/types for whether `insert()` requires a client-supplied key or generates one; if the collection's `getKey` expects `item.id` and the server assigns real TypeIDs, a temporary client-side id is needed for optimistic display until the server response reconciles it. Confirm this against the actual installed package's behavior, not assumption, before finalizing — this is the same kind of empirical check Task 4.3 did for pagination.)
- [ ] Replace `outline`/button oat classes with shadcn `Button` (`variant="outline"` when following, default otherwise).
- [ ] Typecheck, manual verify (curl a profile page that has a follow button, grep for the button text), commit.

### Task 5.5: `PostActions`

**Files:** Modify `examples/twitter-db-tanstack/src/components/PostActions.tsx`

- [ ] Read `examples/twitter-tanstack/src/components/PostActions.tsx`. Same pattern as 5.4: `likes`/`retweets` arrays stay as props (already scoped by the parent), replace the four `useToastMutation(api.X.createMutation/deleteMutation)` calls with direct `api.likes.collection.insert/delete` and `api.retweets.collection.insert/delete` + `toast`. Replace icon buttons' oat classes with Tailwind (`lucide-react` icons — `MessageCircle`, `Repeat2`, `Heart` — replace the emoji spans `💬`/`↻`/`♡`/`♥` with actual icon components for a more shadcn-idiomatic look, since emoji-as-icon was a oat-era convenience, not a deliberate design choice worth preserving).
- [ ] Typecheck, manual verify, commit.

### Task 5.6: `PostCard`

**Files:** Modify `examples/twitter-db-tanstack/src/components/PostCard.tsx`

- [ ] Read `examples/twitter-tanstack/src/components/PostCard.tsx`. Replace the edit/delete `useToastMutation`s with `api.posts.collection.update/delete` + `toast`. Replace the native `<dialog>` edit form with shadcn `Dialog`/`DialogContent`/`DialogHeader`/`DialogFooter`. Replace the native `confirm()` delete prompt with shadcn `AlertDialog` (per the design doc — this was an explicit upgrade target). Replace `.post-x`/`.post-x-header`/etc. classes with a `Card`-based Tailwind layout.
- [ ] Typecheck, manual verify, commit.

### Task 5.7: `ImageUpload`, `ImageLightbox`

**Files:**
- Modify: `examples/twitter-db-tanstack/src/components/ImageUpload.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/ImageLightbox.tsx`

- [ ] Read both reference files. These use `filesApi`/bucket upload — replace with `api.files.attachments`/`api.files.avatars` (from `SyncApi`, unchanged shape per the design doc — files were never a collection). No mutation-hook changes needed here, only the import source (`~/collections` instead of `~/api-client`) and any oat class swaps.
- [ ] Typecheck, manual verify (upload still works — re-run the same curl-based upload test pattern used earlier in `seed.ts`/manual testing this session if one exists, or a simple `curl -F file=@... http://localhost:3003/api/files/attachments` check), commit.

### Task 5.8: `ComposePostDialog`, `ReplyComposer`, `SearchBox`

**Files:**
- Modify: `examples/twitter-db-tanstack/src/components/ComposePostDialog.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/ReplyComposer.tsx`
- Modify: `examples/twitter-db-tanstack/src/components/SearchBox.tsx`

- [ ] Read all three reference files. `ComposePostDialog`: native `<dialog>` → shadcn `Dialog`, `createMutation` → `api.posts.collection.insert`. `ReplyComposer`: same mutation swap, no dialog (it's inline). `SearchBox`: currently `useQuery({...api.posts.listQuery({...listParams, q: term}), enabled: term.length >= 2})` — TanStack DB collections sync a fixed set of rows; full-text search (`?q=`) is a *different kind of query* than "what's already synced," and shouldn't be a collection at all. Keep `SearchBox` calling the underlying REST primitive directly: `api.posts.table.list({ q: term, limit: 20 })` and `api.user.table.list({ q: term, limit: 20 })` (the `table` property each collection entry exposes per Task 2.2's `createTableCollection` return shape) wrapped in a plain `useState`/`useEffect` fetch-on-change (or `@tanstack/react-query`'s `useQuery` directly, since `@tanstack/react-query` is still a dependency — either is fine, this one component is allowed to use react-query directly since it's not collection-shaped data).
- [ ] Typecheck, manual verify, commit.

### Task 5.9: `AppShell`

**Files:** Modify `examples/twitter-db-tanstack/src/components/AppShell.tsx`

- [ ] Read the reference file. Replace the oat-styled nav/layout with Tailwind + shadcn (`Tabs` if applicable for the header nav, otherwise plain `Button`/`Link` styling). No data-layer changes — this component is presentational, receives `user`/`onCompose`/`aside`/`children` as props.
- [ ] Typecheck, manual verify, commit.

### Task 5.10: `index.tsx` (full feed page, building on Task 4.3's collection plumbing)

**Files:** Modify `examples/twitter-db-tanstack/src/routes/index.tsx`

- [ ] Task 4.3 already built a minimal version of this route to validate pagination. This task brings it to full parity with `examples/twitter-tanstack/src/routes/index.tsx`: tabs (For You / Following via shadcn `Tabs`), `ComposePostTrigger`/`ComposePostDialog`, suggestions sidebar (`useLiveQuery` over `api.user.collection` instead of the old `suggestionPoolData`), `LoadMore` integration with the `pageCount` state from Task 4.3.
- [ ] `LoadMore.tsx` itself: port unchanged (it's pure UI + an `IntersectionObserver`, no data-layer or oat dependency — added this session, already framework-agnostic).
- [ ] Typecheck, manual verify (curl the feed, check for post content, check for "Who to follow" sidebar content), commit.

### Task 5.11: `posts.$postId.tsx`

**Files:** Modify `examples/twitter-db-tanstack/src/routes/posts.$postId.tsx`

- [ ] Read `examples/twitter-tanstack/src/routes/posts.$postId.tsx`. Replace the `loader`'s `queryClient.ensureQueryData(...)` prefetch calls (which don't apply to collections — collections sync on creation/mount, not via a router loader prefetch step) with `await api.posts.collection.stateWhenReady()` (or the equivalent "wait for initial sync" call confirmed in Task 2.2) before the component reads from it, so SSR still renders real content instead of an empty state. Replace `authorMap`/`byColumnIn`-scoped `useQuery`s with one `useLiveQuery` join (post + replies + their authors + likes + retweets, mirroring Task 4.3's join pattern). `parseUserIdParam`/`asTypeId`/`notFound()` logic is untouched (no oat or data-layer dependency — same `Buffer`-free `typeid.ts` fix from earlier this session already lives in `bunderstack`, shared by both examples).
- [ ] Typecheck, manual verify (curl a thread page with replies, confirm reply authors resolve — same check as the earlier "Unknown" bug verification), commit.

### Task 5.12: `users.$userId.tsx`

**Files:** Modify `examples/twitter-db-tanstack/src/routes/users.$userId.tsx`

- [ ] Read `examples/twitter-tanstack/src/routes/users.$userId.tsx`. Same loader pattern as 5.11. Follower/following counts: TanStack DB collections don't have a server-side `count: true` aggregate query equivalent exposed through `useLiveQuery` directly — keep using `api.follows.table.list({ followingId: userId, count: true, limit: 1 })` (the raw REST primitive, same as `twitter-tanstack`'s already-fixed approach) rather than counting synced rows client-side, for the same reason it was built that way originally: don't sync potentially-large row sets just to count them.
- [ ] Typecheck, manual verify (curl a busy profile, confirm follower/following counts match DB ground truth — same verification technique used earlier this session), commit.

### Task 5.13: `profile.tsx`, `login.tsx`, `signup.tsx`, `logout.tsx`

**Files:**
- Modify: `examples/twitter-db-tanstack/src/routes/profile.tsx`
- Modify: `examples/twitter-db-tanstack/src/routes/login.tsx`
- Modify: `examples/twitter-db-tanstack/src/routes/signup.tsx`
- Modify: `examples/twitter-db-tanstack/src/routes/logout.tsx`

- [ ] Read all four reference files. `login`/`signup`/`logout` use BetterAuth's client directly (`~/utils/auth-client`, unchanged this whole plan) — port their forms to shadcn `Input`/`Button`/`Card`, swap oat toasts for sonner. `profile.tsx`: replace `api.user.getQuery(user.id)` + `updateMutation` with `useLiveQuery` single-row lookup + `api.user.collection.update(userId, {...})`.
- [ ] Typecheck, manual verify (curl `/login`, confirm form renders; sign in as a seeded user via curl POST same as earlier this session, confirm `/profile` renders with the session cookie), commit.

---

## Phase 6 — Repo wiring and final verification

### Task 6.1: Root scripts and README

**Files:**
- Modify: root `package.json`
- Modify: `examples/README.md`

- [ ] Add to root `package.json` scripts: `"dev:twitter-db-tanstack": "bun run --cwd examples/twitter-db-tanstack dev"`. Add to the `db:push` chain: `&& bun run --cwd examples/twitter-db-tanstack db:push`.
- [ ] Add a row to `examples/README.md`'s example table: `| Twitter (TanStack DB + shadcn) | \`bun run dev:twitter-db-tanstack\` | http://localhost:3003 |`.
- [ ] Commit: `git add package.json examples/README.md && git commit -m "chore: wire twitter-db-tanstack into root scripts and README"`

### Task 6.2: Full verification pass

- [ ] **Typecheck the whole example clean:**

Run: `bunx tsc --noEmit -p examples/twitter-db-tanstack`
Expected: zero errors. If any remain, find which Phase 5 task's file they belong to and fix there, not here.

- [ ] **Full test suite:**

Run: `cd /Users/kirill/pet-projects/bunderstack && bun run test`
Expected: all of `bunderstack`, `bunderstack-query`, `bunderstack-sync` pass.

- [ ] **Fresh dev server, fresh DB, seed, stress-seed:**

```bash
cd examples/twitter-db-tanstack
rm -f data.db
bun run db:push
bun run seed
bun scripts/stress-seed.ts --users=2000 --posts=20000 --replies=5000 --follows=10000 --likes=40000 --retweets=10000
(bun --bun vite dev --port 3003 > /tmp/twitter-db-final.log 2>&1 &)
sleep 4
```

- [ ] **Manual route sweep (mirrors the verification done for `twitter-tanstack` earlier this session):**

```bash
curl -s -o /dev/null -w "feed: %{http_code}\n" "http://localhost:3003/"
curl -s "http://localhost:3003/" | grep -ao 'Unknown' | wc -l   # expect 0
curl -s -o /dev/null -w "login: %{http_code}\n" "http://localhost:3003/login"
```

- [ ] **SSE realtime check — write via one connection, observe the event on another:**

```bash
curl -s -N -H "Accept: text/event-stream" --max-time 3 "http://localhost:3003/api/realtime" > /tmp/sse-out.txt &
SSE_PID=$!
sleep 1
curl -s -X POST "http://localhost:3003/api/auth/sign-in/email" -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"password123"}' -c /tmp/cookies.txt > /dev/null
curl -s -b /tmp/cookies.txt -X POST "http://localhost:3003/api/posts" -H 'Content-Type: application/json' -d '{"title":"SSE check","body":"realtime test"}' > /dev/null
wait $SSE_PID
grep -c "SSE check" /tmp/sse-out.txt
```
Expected: at least `1` (the SSE stream received the create event for the post body containing "SSE check" — note this only fires if the SSE connection had already POSTed its subscription via `/api/realtime` POST with `subscriptions: ["posts"]`; if this returns 0, check whether the curl-based SSE client above also needs to issue that POST — the browser-side `createRealtimeClient` does this automatically via `.subscribe()`, but a raw curl GET alone won't subscribe to any topics. Add the POST subscribe call before the sleep if needed:
```bash
curl -s -X POST "http://localhost:3003/api/realtime" -H 'Content-Type: application/json' -d '{"clientId":"<id from the SSE stream'\''s first frame>","subscriptions":["posts"],"since":null}' > /dev/null
```
extracting `clientId` from `/tmp/sse-out.txt`'s first frame requires reading it after a short delay before the POST.)

- [ ] **Stop the dev server, clean up:**

```bash
pkill -f "vite dev --port 3003"
rm -f /tmp/sse-out.txt /tmp/cookies.txt /tmp/twitter-db-final.log /tmp/twitter-db-dev.log /tmp/feed-step3.html
```

- [ ] **Final commit (only if Task 6.2 required any fixes — if everything passed clean, there's nothing to commit here):**

```bash
git status --short
```
If clean, this task is done with no commit. If there are uncommitted fixes, commit them with a message describing what the final verification pass caught.

---

## Self-review notes (for whoever executes this plan)

- **Scope narrowing vs. the design doc:** the design doc sketched
  `createBunderstackSyncClient().withTables()` / `.withSchema()` / `.with()`
  mirroring `bunderstack-query`'s three entry points. This plan implements
  only `.with()` (Task 2.4) — the one the example actually uses. A real
  `.withSchema()` would need to pull in access-rule resolution
  (`validateAndResolveAccess`) the same way `bunderstack-query`'s does, which
  is meaningfully more work than a thin wrapper and has no consumer in this
  plan. Treat this as a deliberate YAGNI cut, not an oversight — add
  `.withTables()`/`.withSchema()` in a follow-up if a real consumer needs them.
- Phase 1 and Phase 2 are fully TDD-detailed because they're new, reusable library code — get these right, everything else builds on them.
- Phase 5 tasks are intentionally specified as "port + named substitutions," not full inline JSX, because they adapt an already-correct reference app (`twitter-tanstack`) rather than design new behavior. If a Phase 5 task turns out to need a real design decision (not just a mechanical swap), stop and flag it rather than guessing.
- Task 4.3 is the highest-risk task in the plan — it resolves a genuinely open technical question (does `useLiveInfiniteQuery` bound the underlying fetch). Don't skip its empirical verification steps even under time pressure; every later pagination-touching task depends on its answer.
- Every "Typecheck" step's expected-errors note exists because this plan deliberately leaves the example in a broken intermediate state between Phase 3 and the end of Phase 5 (oat removed before all its consumers are ported). That's intentional, not a sign something went wrong — only worry if errors don't match what that step says to expect.
