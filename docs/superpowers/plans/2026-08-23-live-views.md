# Live Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /api/{table}:live` — one SSE stream that opens with a snapshot of a list query and then delivers server-decided `upsert`/`remove` frames — plus a zero-dependency browser client at `bunderstack/live`.

**Architecture:** The live procedure is built beside the CRUD procedures, only when realtime is enabled. It subscribes to the publisher before it reads the snapshot, then holds a per-connection `LiveWindow` that turns each table change into the frames this view needs. The window owns row placement (`afterId`), so the browser never repeats `ORDER BY`. The client core is a reconnecting loop over the stream with a `subscribe`/`getSnapshot` surface.

**Tech Stack:** Bun, oRPC 2.0.0-beta.26 (`@orpc/server`, `@orpc/openapi`), valibot, Drizzle.

**Spec:** [docs/superpowers/specs/2026-08-23-live-views-design.md](../specs/2026-08-23-live-views-design.md)

## Global Constraints

- Branch: `feat/live-views`. Run tests from `packages/bunderstack` with `bun test`.
- Route path is exactly `/api/{table}:live`. Never `/api/{table}/live` and never a `live` flag on the list path — both were verified to break (see the spec's Decisions table).
- Frames are the four in `src/live/protocol.ts`. Do not add a frame type.
- `src/live/**` must stay browser-safe: no `drizzle-orm`, no `better-auth`, no `@orpc/*`, no `node:*`. Server files may import types from it; it may import nothing from the server.
- Sort comparison uses two keys, sort column then `id`, both in the query's direction. This mirrors `buildOrderBy` in `src/list-query.ts:243`.
- Access for a live view is the table's `list` rule plus `readScope`, for the snapshot and for every delta.

---

### Task 1: Shared change guard

**Files:**
- Modify: `packages/bunderstack/src/realtime/filter.ts`
- Test: `packages/bunderstack/src/realtime/filter.test.ts`

**Interfaces:**
- Produces: `createChangeGuard(entry: ResolvedTableAccess, options: { rule: OperationRule; request: Request; getSession: GetSession }): (change: RealtimeChange) => Promise<boolean>` and `filterTableChanges(source: AsyncIterable<RealtimeChange>, options: { tableName: string; entry: ResolvedTableAccess; rule: OperationRule; request: Request; getSession: GetSession }): AsyncGenerator<RealtimeChange>`.
- `filterRealtimeChanges` keeps its current signature and behaviour (it guards with `entry.get`).

- [ ] **Step 1: Write the failing test**

Append to `filter.test.ts`:

```ts
test('filterTableChanges keeps one table and applies the given rule', async () => {
  const access = validateAndResolveAccess(
    { posts },
    { posts: { crud: true, list: 'public', get: 'deny' } },
  )
  const entry = access.get('posts')!
  async function* source() {
    yield { table: 'posts', action: 'create', record: { id: 'p1' } } as RealtimeChange
    yield { table: 'users', action: 'create', record: { id: 'u1' } } as RealtimeChange
    yield { table: 'posts', action: 'update', record: { id: 'p2' } } as RealtimeChange
  }
  const seen: string[] = []
  for await (const change of filterTableChanges(source(), {
    tableName: 'posts',
    entry,
    rule: entry.list,
    request: new Request('http://test/'),
    getSession: async () => ({ user: null, activeOrganizationId: null }),
  })) {
    seen.push(String(change.record.id))
  }
  expect(seen).toEqual(['p1', 'p2'])
})

test('filterTableChanges denies when the rule denies', async () => {
  const access = validateAndResolveAccess(
    { posts },
    { posts: { crud: true, list: 'deny', get: 'public' } },
  )
  const entry = access.get('posts')!
  async function* source() {
    yield { table: 'posts', action: 'create', record: { id: 'p1' } } as RealtimeChange
  }
  const seen: string[] = []
  for await (const change of filterTableChanges(source(), {
    tableName: 'posts',
    entry,
    rule: entry.list,
    request: new Request('http://test/'),
    getSession: async () => ({ user: null, activeOrganizationId: null }),
  })) {
    seen.push(String(change.record.id))
  }
  expect(seen).toEqual([])
})
```

Add the imports the test needs at the top of the file: `filterTableChanges` from `./filter`, `validateAndResolveAccess` from `../access`, and a `posts` table if the file does not already define one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/realtime/filter.test.ts`
Expected: FAIL — `filterTableChanges` is not exported.

- [ ] **Step 3: Write the implementation**

Rewrite `filter.ts` around one guard. Keep the existing file comment style.

```ts
import { getEventMeta, withEventMeta } from '@orpc/server'

import type {
  AccessUser,
  OperationRule,
  ResolvedAccess,
  ResolvedTableAccess,
} from '../access'
import type { RealtimeChange } from './publisher'

import { checkAccess, rowMatchesScope, tableEntryForName } from '../access'

type GetSession = () => Promise<{
  user: AccessUser | null
  activeOrganizationId: string | null
}>

export interface FilterRealtimeChangesOptions {
  subscriptions: readonly string[]
  access: ResolvedAccess
  request: Request
  getSession: GetSession
}

export interface FilterTableChangesOptions {
  /** Events arrive under this name — the schema key they were published with. */
  tableName: string
  entry: ResolvedTableAccess
  /** The operation right this stream reads under: `get` for a subscription,
   * `list` for a live view. */
  rule: OperationRule
  request: Request
  getSession: GetSession
}

/**
 * Whether one change may reach this subscriber: the given right plus the read
 * scope of the row, evaluated against the caller's session. The session
 * resolves at most once per stream.
 */
export function createChangeGuard(
  entry: ResolvedTableAccess,
  options: { rule: OperationRule; request: Request; getSession: GetSession },
): (change: RealtimeChange) => Promise<boolean> {
  let sessionPromise: ReturnType<GetSession> | undefined
  const getSession = () => (sessionPromise ??= options.getSession())

  return async (change) => {
    if (!entry.enabled || options.rule === 'deny') return false

    const needsSession =
      options.rule !== 'public' || entry.readScope !== undefined
    const session = needsSession
      ? await getSession()
      : { user: null, activeOrganizationId: null }
    const context = {
      request: options.request,
      user: session.user,
      row: change.record,
      session: { activeOrganizationId: session.activeOrganizationId },
    }
    if (!(await checkAccess(options.rule, context, entry.ownerColumn)).allowed) {
      return false
    }
    if (
      entry.readScope &&
      !rowMatchesScope(change.record, entry.readScope(context))
    ) {
      return false
    }
    return true
  }
}

/** Preserve publisher event metadata (ids) across the projection. */
function project(change: RealtimeChange): RealtimeChange {
  const projected: RealtimeChange = {
    table: change.table,
    action: change.action,
    record: change.record,
  }
  const meta = getEventMeta(change)
  return meta ? withEventMeta(projected, meta) : projected
}

export async function* filterRealtimeChanges(
  source: AsyncIterable<RealtimeChange>,
  options: FilterRealtimeChangesOptions,
): AsyncGenerator<RealtimeChange, void, void> {
  const subscriptions = new Set(options.subscriptions)
  // One guard — and therefore one cached session — per table entry.
  const guards = new Map<
    ResolvedTableAccess,
    ReturnType<typeof createChangeGuard>
  >()

  for await (const change of source) {
    // Events name tables by schema key; the SQL-name lookup stays as a fallback
    // for publishers outside the CRUD path that only know the physical name.
    const entry =
      options.access.get(change.table) ??
      tableEntryForName(options.access, change.table)
    if (!entry?.enabled) continue

    const recordId = change.record.id
    if (
      !subscriptions.has(change.table) &&
      (recordId == null ||
        !subscriptions.has(`${change.table}/${String(recordId)}`))
    ) {
      continue
    }

    let guard = guards.get(entry)
    if (!guard) {
      guard = createChangeGuard(entry, { ...options, rule: entry.get })
      guards.set(entry, guard)
    }
    if (!(await guard(change))) continue
    yield project(change)
  }
}

/**
 * The same stream narrowed to one table with its access entry known up front —
 * what a live view (`GET /{table}:live`) consumes.
 */
export async function* filterTableChanges(
  source: AsyncIterable<RealtimeChange>,
  options: FilterTableChangesOptions,
): AsyncGenerator<RealtimeChange, void, void> {
  const guard = createChangeGuard(options.entry, options)
  for await (const change of source) {
    if (change.table !== options.tableName) continue
    if (!(await guard(change))) continue
    yield project(change)
  }
}
```

If `OperationRule` is not exported from `../access`, export it there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/bunderstack && bun test src/realtime/`
Expected: PASS, including the pre-existing `filterRealtimeChanges` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/realtime/filter.ts packages/bunderstack/src/realtime/filter.test.ts packages/bunderstack/src/access.ts
git commit -m "refactor(realtime): share one change guard between streams"
```

---

### Task 2: Wire protocol and membership

**Files:**
- Create: `packages/bunderstack/src/live/protocol.ts`
- Create: `packages/bunderstack/src/api/live-view.ts`
- Test: `packages/bunderstack/src/api/live-view.test.ts`

**Interfaces:**
- Produces: `LiveFrame<T>`, `LiveSnapshotFrame<T>`, `LiveUpsertFrame<T>`, `LiveRemoveFrame`, `LiveHeartbeatFrame`, `LiveDeltaFrame<T>`, `LiveInput` from `src/live/protocol.ts`; `matchesLiveFilters(record, filters)` from `src/api/live-view.ts`.

- [ ] **Step 1: Write the failing test**

`src/api/live-view.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { matchesLiveFilters } from './live-view'

describe('matchesLiveFilters', () => {
  test('no filters matches everything', () => {
    expect(matchesLiveFilters({ id: 'a' }, undefined)).toBe(true)
    expect(matchesLiveFilters({ id: 'a' }, {})).toBe(true)
  })

  test('a scalar is equality', () => {
    expect(matchesLiveFilters({ userId: 'u1' }, { userId: 'u1' })).toBe(true)
    expect(matchesLiveFilters({ userId: 'u2' }, { userId: 'u1' })).toBe(false)
  })

  test('an array is IN', () => {
    expect(matchesLiveFilters({ status: 'b' }, { status: ['a', 'b'] })).toBe(true)
    expect(matchesLiveFilters({ status: 'c' }, { status: ['a', 'b'] })).toBe(false)
  })

  test('null is IS NULL, and undefined counts as null', () => {
    expect(matchesLiveFilters({ teamId: null }, { teamId: null })).toBe(true)
    expect(matchesLiveFilters({}, { teamId: null })).toBe(true)
    expect(matchesLiveFilters({ teamId: 't1' }, { teamId: null })).toBe(false)
  })

  test('the string form of null never leaks through', () => {
    expect(matchesLiveFilters({ teamId: null }, { teamId: 'null' })).toBe(true)
  })

  test('undefined filter entries are skipped', () => {
    expect(matchesLiveFilters({ a: 1 }, { a: undefined })).toBe(true)
  })

  test('dates compare by time', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(matchesLiveFilters({ at }, { at: new Date(at.getTime()) })).toBe(true)
    expect(matchesLiveFilters({ at }, { at: new Date(0) })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/api/live-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/live/protocol.ts` — types only, so both sides share one definition:

```ts
/**
 * The wire frames of a live view (`GET /api/{table}:live`).
 *
 * A live view is one SSE stream that opens with a snapshot of a list query and
 * then delivers only what that view cares about. The server decides membership
 * and placement, so a client applies frames without knowing the filter or sort
 * rules, and a reconnect replays a fresh snapshot instead of a refetch.
 *
 * Types only: this module is imported by the browser client and by the server.
 */

export type LiveSnapshotFrame<TRow = Record<string, unknown>> = {
  type: 'snapshot'
  items: TRow[]
  /** The values the server resolved, not the values the caller sent. */
  sort: string
  order: 'asc' | 'desc'
  limit: number
  /** True when rows exist below the window. */
  hasMore: boolean
}

export type LiveUpsertFrame<TRow = Record<string, unknown>> = {
  type: 'upsert'
  record: TRow
  /** The id this row follows in the view; `null` means the head. */
  afterId: string | null
}

export type LiveRemoveFrame = { type: 'remove'; id: string }

export type LiveHeartbeatFrame = { type: 'heartbeat'; intervalMs: number }

export type LiveDeltaFrame<TRow = Record<string, unknown>> =
  | LiveUpsertFrame<TRow>
  | LiveRemoveFrame

export type LiveFrame<TRow = Record<string, unknown>> =
  | LiveSnapshotFrame<TRow>
  | LiveDeltaFrame<TRow>
  | LiveHeartbeatFrame

/** The query a live view accepts: the list contract a stream can honor. */
export type LiveInput = {
  limit?: number
  sort?: string
  order?: 'asc' | 'desc'
  filters?: Record<string, unknown>
}
```

`src/api/live-view.ts`:

```ts
/**
 * Server-side membership for a live view: does one record belong to a view,
 * given that view's filters? Evaluated per streamed record, so a change is
 * routed without asking the database.
 */

/** Same value semantics as list filters: dates by time, the rest by identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Bunderstack's filter contract — a scalar is `=`, an array is `IN`, `null` is
 * `IS NULL` — evaluated against one record. `'null'` is accepted as well,
 * because a query string cannot carry a real null.
 */
export function matchesLiveFilters(
  record: Record<string, unknown>,
  filters: Record<string, unknown> | undefined,
): boolean {
  for (const [column, expected] of Object.entries(filters ?? {})) {
    if (expected === undefined) continue
    const actual = record[column]
    if (expected === null || expected === 'null') {
      if (!isNullish(actual)) return false
      continue
    }
    if (Array.isArray(expected)) {
      if (!expected.some((value) => sameValue(value, actual))) return false
      continue
    }
    if (!sameValue(expected, actual)) return false
  }
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/bunderstack && bun test src/api/live-view.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/live/protocol.ts packages/bunderstack/src/api/live-view.ts packages/bunderstack/src/api/live-view.test.ts
git commit -m "feat(live): add the live-view wire protocol and membership rule"
```

---

### Task 3: The per-connection window

**Files:**
- Create: `packages/bunderstack/src/api/live-window.ts`
- Test: `packages/bunderstack/src/api/live-window.test.ts`

**Interfaces:**
- Consumes: `matchesLiveFilters` (Task 2), `LiveDeltaFrame` (Task 2), `RealtimeChange` from `../realtime/publisher`.
- Produces: `createLiveWindow(options: { sort: string; order: 'asc' | 'desc'; limit: number; filters?: Record<string, unknown> }): LiveWindow` where `LiveWindow = { reset(items: Record<string, unknown>[], hasMore: boolean): void; apply(change: RealtimeChange): LiveWindowResult }` and `LiveWindowResult = { type: 'none' } | { type: 'frames'; frames: LiveDeltaFrame[] } | { type: 'resnapshot' }`.

- [ ] **Step 1: Write the failing test**

`src/api/live-window.test.ts`:

```ts
import { expect, test } from 'bun:test'

import type { RealtimeChange } from '../realtime/publisher'

import { createLiveWindow } from './live-window'

const row = (id: string, rank: number, userId = 'u1') => ({ id, rank, userId })

const change = (
  action: RealtimeChange['action'],
  record: Record<string, unknown>,
): RealtimeChange => ({ table: 'posts', action, record })

function windowOf(
  items: Record<string, unknown>[],
  hasMore: boolean,
  options: Partial<Parameters<typeof createLiveWindow>[0]> = {},
) {
  const view = createLiveWindow({
    sort: 'rank',
    order: 'asc',
    limit: 3,
    ...options,
  })
  view.reset(items, hasMore)
  return view
}

test('a new row lands after its predecessor', () => {
  const view = windowOf([row('a', 1), row('c', 3)], false)
  const result = view.apply(change('create', row('b', 2)))
  expect(result).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('b', 2), afterId: 'a' }],
  })
})

test('a new head row reports a null anchor', () => {
  const view = windowOf([row('b', 2)], false)
  const result = view.apply(change('create', row('a', 1)))
  expect(result).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('a', 1), afterId: null }],
  })
})

test('an update that moves a row re-anchors it', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], false)
  const result = view.apply(change('update', row('a', 9)))
  expect(result).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('a', 9), afterId: 'c' }],
  })
})

test('rows with an equal sort key break the tie by id, as SQL does', () => {
  const view = windowOf([row('a', 1), row('c', 1)], false)
  const result = view.apply(change('create', row('b', 1)))
  expect(result).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('b', 1), afterId: 'a' }],
  })
})

test('descending order inverts both keys', () => {
  const view = windowOf([row('c', 3), row('a', 1)], false, { order: 'desc' })
  const result = view.apply(change('create', row('b', 2)))
  expect(result).toEqual({
    type: 'frames',
    frames: [{ type: 'upsert', record: row('b', 2), afterId: 'c' }],
  })
})

test('a full window evicts its last row', () => {
  const view = windowOf([row('b', 2), row('c', 3), row('d', 4)], false)
  const result = view.apply(change('create', row('a', 1)))
  expect(result).toEqual({
    type: 'frames',
    frames: [
      { type: 'upsert', record: row('a', 1), afterId: null },
      { type: 'remove', id: 'd' },
    ],
  })
})

test('a row that sorts below a full window is ignored', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], true)
  expect(view.apply(change('create', row('z', 9)))).toEqual({ type: 'none' })
})

test('a delete inside a complete view removes the row', () => {
  const view = windowOf([row('a', 1), row('b', 2)], false)
  expect(view.apply(change('delete', row('a', 1)))).toEqual({
    type: 'frames',
    frames: [{ type: 'remove', id: 'a' }],
  })
})

test('a delete inside a truncated view asks for a fresh snapshot', () => {
  const view = windowOf([row('a', 1), row('b', 2), row('c', 3)], true)
  expect(view.apply(change('delete', row('a', 1)))).toEqual({
    type: 'resnapshot',
  })
})

test('a delete outside the view says nothing', () => {
  const view = windowOf([row('a', 1)], true)
  expect(view.apply(change('delete', row('z', 9)))).toEqual({ type: 'none' })
})

test('an update that leaves the filters removes the row', () => {
  const view = windowOf([row('a', 1), row('b', 2)], false, {
    filters: { userId: 'u1' },
  })
  expect(view.apply(change('update', row('a', 1, 'u2')))).toEqual({
    type: 'frames',
    frames: [{ type: 'remove', id: 'a' }],
  })
})

test('a create that never matched the filters says nothing', () => {
  const view = windowOf([row('a', 1)], false, { filters: { userId: 'u1' } })
  expect(view.apply(change('create', row('z', 9, 'u2')))).toEqual({
    type: 'none',
  })
})

test('an eviction marks the view truncated', () => {
  const view = windowOf([row('b', 2), row('c', 3), row('d', 4)], false)
  view.apply(change('create', row('a', 1)))
  // 'd' now sits below the window, so the next removal needs a re-query.
  expect(view.apply(change('delete', row('a', 1)))).toEqual({
    type: 'resnapshot',
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/api/live-window.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/api/live-window.ts`:

```ts
import type { LiveDeltaFrame } from '../live/protocol'
import type { RealtimeChange } from '../realtime/publisher'

import { matchesLiveFilters } from './live-view'

/**
 * The server-side state of one live-view connection: which rows the client
 * holds, in view order, and whether rows exist below the window.
 *
 * The window is what lets the server place a row for the client (`afterId`)
 * instead of making the browser repeat `ORDER BY`, and what makes a removal
 * from a truncated view ask for a fresh snapshot instead of silently shrinking
 * the view.
 *
 * Ordering follows `buildOrderBy` in `../list-query`: the sort column first,
 * then `id`, both in the query's direction. Values are compared in the process
 * on raw column values. That is exact for numbers, dates, and booleans, and
 * matches the database for ordinary text; a collation that differs from
 * code-unit order, or a NULLS ordering that differs from "nulls first", can
 * place a row inside the window differently from the database.
 */

export type LiveWindowOptions = {
  sort: string
  order: 'asc' | 'desc'
  limit: number
  filters?: Record<string, unknown>
}

export type LiveWindowResult =
  | { type: 'none' }
  | { type: 'frames'; frames: LiveDeltaFrame[] }
  | { type: 'resnapshot' }

export type LiveWindow = {
  /** Adopt a query result as the current view. */
  reset: (items: Record<string, unknown>[], hasMore: boolean) => void
  /** What this change means for this view. */
  apply: (change: RealtimeChange) => LiveWindowResult
}

type WindowRow = { id: string; key: unknown }

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) return aNull ? (bNull ? 0 : -1) : 1
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  }
  const left = String(a)
  const right = String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export function createLiveWindow(options: LiveWindowOptions): LiveWindow {
  const direction = options.order === 'desc' ? -1 : 1
  let rows: WindowRow[] = []
  let hasMore = false

  const compareRows = (a: WindowRow, b: WindowRow): number =>
    direction * (compareValues(a.key, b.key) || compareValues(a.id, b.id))

  const rowOf = (record: Record<string, unknown>): WindowRow => ({
    id: String(record.id),
    key: record[options.sort],
  })

  /** Where this row belongs among rows that are already in order. */
  const placeOf = (row: WindowRow): number => {
    const index = rows.findIndex((current) => compareRows(row, current) < 0)
    return index === -1 ? rows.length : index
  }

  return {
    reset(items, nextHasMore) {
      rows = items.map(rowOf)
      hasMore = nextHasMore
    },

    apply(change) {
      const id = String(change.record.id)
      const index = rows.findIndex((row) => row.id === id)
      const held = index !== -1

      // The row left the view: deleted, or it no longer matches the filters.
      if (
        change.action === 'delete' ||
        !matchesLiveFilters(change.record, options.filters)
      ) {
        if (!held) return { type: 'none' }
        rows.splice(index, 1)
        // A row from below the window must take the free place, and only the
        // database knows which one.
        if (hasMore) return { type: 'resnapshot' }
        return { type: 'frames', frames: [{ type: 'remove', id }] }
      }

      if (held) rows.splice(index, 1)
      const row = rowOf(change.record)
      const place = placeOf(row)

      if (place >= options.limit) {
        // It sorts below the window. If the client holds it, it moved out.
        if (!held) return { type: 'none' }
        hasMore = true
        return { type: 'frames', frames: [{ type: 'remove', id }] }
      }

      rows.splice(place, 0, row)
      const frames: LiveDeltaFrame[] = [
        {
          type: 'upsert',
          record: change.record,
          afterId: place === 0 ? null : rows[place - 1]!.id,
        },
      ]
      if (rows.length > options.limit) {
        const evicted = rows.pop()!
        hasMore = true
        frames.push({ type: 'remove', id: evicted.id })
      }
      return { type: 'frames', frames }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/bunderstack && bun test src/api/live-window.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/api/live-window.ts packages/bunderstack/src/api/live-window.test.ts
git commit -m "feat(live): add the per-connection live window"
```

---

### Task 4: The live input schema

**Files:**
- Modify: `packages/bunderstack/src/api/list-input-schema.ts`
- Test: `packages/bunderstack/src/api/list-input-schema.test.ts` (create if absent)

**Interfaces:**
- Produces: `buildLiveInputSchema(table, { filterableColumns, sortableColumns })` — the list schema without `q`, `offset`, `cursor`, and `count`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { buildLiveInputSchema } from './list-input-schema'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  likes: integer('likes'),
})

const schema = buildLiveInputSchema(posts, {
  filterableColumns: ['userId'],
  sortableColumns: ['id', 'likes'],
})

test('a live input accepts limit, sort, order, and filters', () => {
  const parsed = v.parse(schema, {
    limit: 10,
    sort: 'likes',
    order: 'desc',
    filters: { userId: 'u1' },
  })
  expect(parsed).toEqual({
    limit: 10,
    sort: 'likes',
    order: 'desc',
    filters: { userId: 'u1' },
  })
})

test('a live input rejects what a stream cannot honor', () => {
  for (const input of [{ q: 'x' }, { offset: 10 }, { cursor: 'c' }]) {
    expect(() => v.parse(schema, input)).toThrow()
  }
})

test('a live input rejects a column that is not sortable', () => {
  expect(() => v.parse(schema, { sort: 'userId' })).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/api/list-input-schema.test.ts`
Expected: FAIL — `buildLiveInputSchema` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `list-input-schema.ts`:

```ts
/**
 * The input contract of a live view (`GET /api/{table}:live`): the list
 * contract narrowed to what a stream can honor. No text search, no pagination.
 * Membership is decided per streamed record on the server, which only
 * equality-style filters allow.
 */
export function buildLiveInputSchema(
  table: Table,
  options: {
    filterableColumns: readonly string[]
    sortableColumns: readonly string[]
  },
) {
  const filterEntries = buildFilterEntries(table, options.filterableColumns)

  return v.optional(
    v.strictObject({
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      sort: v.optional(v.picklist(options.sortableColumns as string[])),
      order: v.optional(v.picklist(['asc', 'desc'])),
      // Always present, even with no filterable columns: clients send `{}`.
      filters: v.optional(v.strictObject(filterEntries)),
    }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/bunderstack && bun test src/api/list-input-schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/api/list-input-schema.ts packages/bunderstack/src/api/list-input-schema.test.ts
git commit -m "feat(live): add the live-view input schema"
```

---

### Task 5: The live procedure

**Files:**
- Modify: `packages/bunderstack/src/api/crud-router.ts`
- Modify: `packages/bunderstack/src/index.ts` (pass the publisher)
- Test: `packages/bunderstack/src/api/live-router.test.ts`

**Interfaces:**
- Consumes: `filterTableChanges` (Task 1), `LiveInput`/`LiveFrame` (Task 2), `createLiveWindow` (Task 3), `buildLiveInputSchema` (Task 4).
- Produces: `router[table].live`, reachable at `GET /api/{table}:live`; `CrudApiRouterOptions.livePublisher`; `BuildTableCrudProceduresArgs.schemaKey` and `.livePublisher`; the exported type `LiveInputFor<TTable, TFilterable, TSortable>`.

- [ ] **Step 1: Write the failing test**

`src/api/live-router.test.ts`:

```ts
import { PGlite } from '@electric-sql/pglite'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { expect, test } from 'bun:test'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'

import type { RealtimeChange } from '../realtime/publisher'

import { validateAndResolveAccess } from '../access'
import { createMemoryRealtimePublisher } from '../realtime/publisher'
import { createApiContext } from './context'
import { buildCrudApiRouter } from './crud-router'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('user_id'),
  rank: integer('rank'),
})

const schema = { posts }

async function setupTestDb() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      user_id TEXT,
      rank INTEGER
    );
  `)
  return drizzle(client, { schema })
}

function context(request: Request) {
  return createApiContext(
    {
      db: {},
      env: {},
      storage: {} as never,
      email: {} as never,
      jobs: {} as never,
      realtime: {} as never,
      auth: {} as never,
    },
    request,
  )
}

/** Reads SSE data frames until one satisfies `until`, or the cap is hit. */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (frame: Record<string, unknown>) => boolean,
  cap = 20,
): Promise<Record<string, unknown>[]> {
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Record<string, unknown>[] = []
  for (let index = 0; index < cap; index++) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>
        frames.push(frame)
        if (until(frame)) return frames
      }
    }
  }
  return frames
}

function liveAccess(rule: 'public' | 'deny' = 'public') {
  return validateAndResolveAccess(schema, {
    posts: {
      crud: true,
      list: rule,
      get: 'public',
      create: 'public',
      update: 'public',
      delete: 'public',
      filterableColumns: ['userId'],
      sortableColumns: ['rank'],
      defaultSort: { column: 'rank', order: 'asc' },
    },
  })
}

test('a live view streams a snapshot and then server-placed changes', async () => {
  const db = await setupTestDb()
  await db.insert(posts).values([
    { id: 'p1', title: 'in view', userId: 'u1', rank: 1 },
    { id: 'p2', title: 'out of view', userId: 'u2', rank: 2 },
    { id: 'p3', title: 'also in view', userId: 'u1', rank: 3 },
  ])

  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const router = buildCrudApiRouter(schema, db, {
    access: liveAccess(),
    livePublisher: publisher,
  })
  expect(Object.keys(router.posts)).toContain('live')

  const handler = new OpenAPIHandler({ router })
  const controller = new AbortController()
  const request = new Request(
    `http://test/api/posts:live?filters=${encodeURIComponent(
      JSON.stringify({ userId: 'u1' }),
    )}`,
    { signal: controller.signal },
  )
  const result = await handler.handle(request, { context: context(request) })
  expect(result.matched).toBe(true)
  expect(result.response?.headers.get('Content-Type')).toContain(
    'text/event-stream',
  )

  const reader = result.response!.body!.getReader()
  try {
    const untilSnapshot = await readFrames(reader, (frame) =>
      ['snapshot', 'heartbeat'].includes(String(frame.type)),
    )
    const snapshot = untilSnapshot.find((frame) => frame.type === 'snapshot')!
    expect(snapshot).toBeDefined()
    expect((snapshot.items as { id: string }[]).map((item) => item.id)).toEqual([
      'p1',
      'p3',
    ])
    // Resolved values, not the caller's input: the request sent no sort.
    expect(snapshot.sort).toBe('rank')
    expect(snapshot.order).toBe('asc')
    expect(snapshot.hasMore).toBe(false)
    expect(typeof snapshot.limit).toBe('number')

    // A new row in the middle of the view carries its anchor.
    await publisher.publish('change', {
      table: 'posts',
      action: 'create',
      record: { id: 'p4', title: 'between', userId: 'u1', rank: 2 },
    } satisfies RealtimeChange)
    const untilUpsert = await readFrames(
      reader,
      (frame) => frame.type === 'upsert' || frame.type === 'heartbeat',
    )
    const upsert = untilUpsert.find((frame) => frame.type === 'upsert')!
    expect(upsert).toBeDefined()
    expect(upsert.afterId).toBe('p1')

    // An update that leaves the filters removes the row from the view.
    await publisher.publish('change', {
      table: 'posts',
      action: 'update',
      record: { id: 'p1', title: 'moved out', userId: 'u2', rank: 1 },
    } satisfies RealtimeChange)
    const untilRemove = await readFrames(
      reader,
      (frame) => frame.type === 'remove' || frame.type === 'heartbeat',
    )
    expect(untilRemove.find((frame) => frame.id === 'p1')).toBeDefined()

    // A change on another table stays silent: the next frame is a heartbeat.
    await publisher.publish('change', {
      table: 'users',
      action: 'create',
      record: { id: 'u9' },
    } satisfies RealtimeChange)
  } finally {
    controller.abort()
    await reader.cancel()
  }
})

test('a live view denies the deltas when it denies the list', async () => {
  const db = await setupTestDb()
  await db.insert(posts).values([{ id: 'p1', title: 'x', userId: 'u1', rank: 1 }])
  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const router = buildCrudApiRouter(schema, db, {
    access: liveAccess('deny'),
    livePublisher: publisher,
  })
  const handler = new OpenAPIHandler({ router })
  const controller = new AbortController()
  const request = new Request('http://test/api/posts:live', {
    signal: controller.signal,
  })
  const result = await handler.handle(request, { context: context(request) })
  const text = await result.response!.text()
  expect(text).not.toContain('"type":"snapshot"')
  controller.abort()
})

test('the live path does not shadow an id that reads "live"', async () => {
  const db = await setupTestDb()
  await db.insert(posts).values([{ id: 'live', title: 'x', userId: 'u1', rank: 1 }])
  const publisher = createMemoryRealtimePublisher({ resumeSeconds: 60 })
  const router = buildCrudApiRouter(schema, db, {
    access: liveAccess(),
    livePublisher: publisher,
  })
  const handler = new OpenAPIHandler({ router })
  const request = new Request('http://test/api/posts/live')
  const result = await handler.handle(request, { context: context(request) })
  expect(result.response?.headers.get('Content-Type')).toContain(
    'application/json',
  )
  expect(await result.response!.json()).toMatchObject({ id: 'live' })
})

test('no live procedure without a publisher', () => {
  const router = buildCrudApiRouter(schema, undefined as never, {
    access: liveAccess(),
  })
  expect(router.posts.live).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/api/live-router.test.ts`
Expected: FAIL — `livePublisher` is not an option and `router.posts.live` does not exist.

- [ ] **Step 3: Write the implementation**

In `crud-router.ts`, add the imports:

```ts
import { eventIterator } from '@orpc/server'

import type { RealtimePublisher } from '../realtime/publisher'
import type { LiveSnapshotFrame } from '../live/protocol'

import {
  REALTIME_HEARTBEAT_INTERVAL_MS,
  withRealtimeHeartbeat,
} from '../realtime/heartbeat'
import { filterTableChanges } from '../realtime/filter'
import { createLiveWindow } from './live-window'
import { buildListInputSchema, buildLiveInputSchema } from './list-input-schema'
```

Add `livePublisher?: RealtimePublisher` to `CrudApiRouterOptions` with this comment:

```ts
  /**
   * The raw realtime publisher, present when realtime is enabled. The CRUD
   * router subscribes on behalf of live views; publishing stays behind the
   * facade.
   */
```

Add to `BuildTableCrudProceduresArgs`:

```ts
  /** The schema key events are published under (usually the SQL name). */
  schemaKey: string
  /** Present when realtime is enabled; without it no live procedure is built. */
  livePublisher?: RealtimePublisher
```

Destructure them in `buildTableCrudProcedures`, and add the caller-facing input type next to `ListInputFor`:

```ts
/**
 * The live-view input as callers see it: the list contract narrowed to what a
 * stream can honor — no text search, no pagination.
 */
export type LiveInputFor<
  TTable extends Table,
  TFilterable extends string,
  TSortable extends string,
> = {
  limit?: number
  sort?: TSortable
  order?: 'asc' | 'desc'
  filters?: ListFilters<TTable, TFilterable>
}
```

After the delete procedure, add the live procedure:

```ts
  // 6. LIVE procedure — the whole view as one stream. A snapshot first, then
  // the changes this view cares about, placed by the server. Every connection
  // opens with a snapshot, so a reconnect is its own recovery: no client-side
  // event buffer, no Last-Event-ID bookkeeping, no refetch path.
  const liveQuerySchema = buildLiveInputSchema(table, {
    filterableColumns: access.filterableColumns,
    sortableColumns: access.sortableColumns,
  }) as unknown as v.GenericSchema<
    LiveInputFor<TTable, TFilterable, TSortable>,
    LiveInputFor<TTable, TFilterable, TSortable>
  >

  const recordSchema = v.record(v.string(), v.unknown())
  const liveFrameSchema = v.union([
    v.strictObject({
      type: v.literal('snapshot'),
      items: v.array(recordSchema),
      sort: v.string(),
      order: v.picklist(['asc', 'desc']),
      limit: v.number(),
      hasMore: v.boolean(),
    }),
    v.strictObject({
      type: v.literal('upsert'),
      record: recordSchema,
      afterId: v.union([v.string(), v.null()]),
    }),
    v.strictObject({ type: v.literal('remove'), id: v.string() }),
    v.strictObject({ type: v.literal('heartbeat'), intervalMs: v.number() }),
  ])

  const live = !livePublisher
    ? undefined
    : builder.public
        .route({
          method: 'GET',
          // A custom method, not a child resource: `/{table}/live` would
          // shadow the id "live" on the get route.
          path: `/api/${name}:live`,
          summary: `Live view of ${name}`,
          tags: [name],
          // Filters arrive as one URL-encoded JSON value, so no per-key query
          // parsing rule is needed.
          queryStyles: { filters: 'json' },
        })
        .input(liveQuerySchema)
        .output(eventIterator(liveFrameSchema))
        .handler(({ input, context, signal }) => {
          // Subscribe before anything awaits, so no change slips between the
          // snapshot read and the start of the stream; events that arrive
          // during the query buffer in the publisher and replay on first pull.
          const changes = filterTableChanges(
            livePublisher.subscribe('change', { signal }),
            {
              tableName: schemaKey,
              entry: access,
              rule: access.list,
              request: context.request,
              getSession: context.getSession,
            },
          )

          return withRealtimeHeartbeat(
            (async function* () {
              const session = await context.getSession()
              const execCtx = {
                request: context.request,
                user: session.user,
                session: { activeOrganizationId: session.activeOrganizationId },
              }
              let view: ReturnType<typeof createLiveWindow> | undefined

              const readSnapshot = async (): Promise<LiveSnapshotFrame> => {
                const result = await operations.list(name, input ?? {}, execCtx)
                view = createLiveWindow({
                  sort: result.sort,
                  order: result.order,
                  limit: result.limit,
                  filters: input?.filters as
                    | Record<string, unknown>
                    | undefined,
                })
                view.reset(result.items, result.hasMore)
                return {
                  type: 'snapshot',
                  items: result.items,
                  sort: result.sort,
                  order: result.order,
                  limit: result.limit,
                  hasMore: result.hasMore,
                }
              }

              yield await readSnapshot()

              for await (const change of changes) {
                const outcome = view!.apply(change)
                if (outcome.type === 'none') continue
                if (outcome.type === 'resnapshot') {
                  yield await readSnapshot()
                  continue
                }
                for (const frame of outcome.frames) yield frame
              }
            })(),
            { intervalMs: REALTIME_HEARTBEAT_INTERVAL_MS, signal },
          )
        })
```

Return the live procedure without widening the other four:

```ts
  return {
    list,
    get,
    create,
    update,
    delete: deleteProc,
    ...(live ? { live } : {}),
  } as {
    list: typeof list
    get: typeof get
    create: typeof create
    update: typeof update
    delete: typeof deleteProc
    live?: NonNullable<typeof live>
  }
```

In `buildCrudApiRouter`, destructure `livePublisher` from the options and pass `schemaKey: tableKey` and `livePublisher` into `buildTableCrudProcedures`. In `src/index.ts`, pass `livePublisher: publisher` where `buildCrudApiRouter` is called (beside `realtime`).

If a snapshot read throws (a denied list), let it reject: the stream ends with an error frame, which is what the deny test asserts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/bunderstack && bun test src/api/`
Expected: PASS, including the pre-existing CRUD and OpenAPI tests.

- [ ] **Step 5: Check the OpenAPI document**

Run: `cd packages/bunderstack && bun test src/api/openapi.test.ts`
Expected: PASS. If a snapshot of the document lists paths, add `/api/{table}:live` to it.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/api/crud-router.ts packages/bunderstack/src/api/live-router.test.ts packages/bunderstack/src/index.ts
git commit -m "feat(live): serve GET /api/{table}:live beside the CRUD routes"
```

---

### Task 6: Client fold and SSE reader

**Files:**
- Create: `packages/bunderstack/src/live/apply.ts`
- Create: `packages/bunderstack/src/live/sse.ts`
- Test: `packages/bunderstack/src/live/apply.test.ts`, `packages/bunderstack/src/live/sse.test.ts`

**Interfaces:**
- Consumes: `LiveFrame` (Task 2).
- Produces: `applyLiveFrame<T extends { id: string }>(rows: readonly T[], frame: LiveFrame<T>): readonly T[]` and `parseSseFrames<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T>`.

- [ ] **Step 1: Write the failing tests**

`src/live/apply.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { applyLiveFrame } from './apply'

type Row = { id: string; title: string }
const row = (id: string): Row => ({ id, title: id })

test('a snapshot replaces the view', () => {
  const rows = applyLiveFrame<Row>([row('x')], {
    type: 'snapshot',
    items: [row('a'), row('b')],
    sort: 'id',
    order: 'asc',
    limit: 100,
    hasMore: false,
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
})

test('an upsert inserts after its anchor', () => {
  const rows = applyLiveFrame<Row>([row('a'), row('c')], {
    type: 'upsert',
    record: row('b'),
    afterId: 'a',
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b', 'c'])
})

test('a null anchor inserts at the head', () => {
  const rows = applyLiveFrame<Row>([row('b')], {
    type: 'upsert',
    record: row('a'),
    afterId: null,
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
})

test('an upsert of a held row moves it instead of duplicating it', () => {
  const rows = applyLiveFrame<Row>([row('a'), row('b'), row('c')], {
    type: 'upsert',
    record: { id: 'a', title: 'moved' },
    afterId: 'c',
  })
  expect(rows.map((item) => item.id)).toEqual(['b', 'c', 'a'])
  expect(rows[2]!.title).toBe('moved')
})

test('an unknown anchor appends instead of jumping to the head', () => {
  const rows = applyLiveFrame<Row>([row('a')], {
    type: 'upsert',
    record: row('b'),
    afterId: 'gone',
  })
  expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
})

test('a remove drops one row, and an unknown id is a no-op', () => {
  const rows = applyLiveFrame<Row>([row('a'), row('b')], {
    type: 'remove',
    id: 'a',
  })
  expect(rows.map((item) => item.id)).toEqual(['b'])
  expect(applyLiveFrame<Row>(rows, { type: 'remove', id: 'z' })).toBe(rows)
})

test('a heartbeat keeps the same array reference', () => {
  const rows: readonly Row[] = [row('a')]
  expect(
    applyLiveFrame<Row>(rows, { type: 'heartbeat', intervalMs: 5000 }),
  ).toBe(rows)
})
```

`src/live/sse.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { parseSseFrames } from './sse'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('frames arrive one per blank-line block, across chunk splits', async () => {
  const stream = streamOf([
    ': keepalive\n\n',
    'event: message\ndata: {"type":"heart',
    'beat","intervalMs":5000}\n\n',
    'event: message\ndata: {"type":"remove",',
    '"id":"a"}\n\nevent: close\n\n',
  ])
  const frames: unknown[] = []
  for await (const frame of parseSseFrames(stream)) frames.push(frame)
  expect(frames).toEqual([
    { type: 'heartbeat', intervalMs: 5000 },
    { type: 'remove', id: 'a' },
  ])
})

test('a multi-line data payload joins with newlines', async () => {
  const stream = streamOf(['data: {"type":"remove",\ndata: "id":"a"}\n\n'])
  const frames: unknown[] = []
  for await (const frame of parseSseFrames(stream)) frames.push(frame)
  expect(frames).toEqual([{ type: 'remove', id: 'a' }])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/bunderstack && bun test src/live/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/live/apply.ts`:

```ts
import type { LiveFrame } from './protocol'

/**
 * One frame folded into a view's rows.
 *
 * Pure and immutable: a changed view is a new array, an unchanged view is the
 * same array. That is what `useSyncExternalStore` and a keyed list need to skip
 * the rows a frame did not touch.
 */
export function applyLiveFrame<TRow extends { id: string }>(
  rows: readonly TRow[],
  frame: LiveFrame<TRow>,
): readonly TRow[] {
  if (frame.type === 'snapshot') return frame.items
  if (frame.type === 'heartbeat') return rows

  if (frame.type === 'remove') {
    const next = rows.filter((row) => row.id !== frame.id)
    return next.length === rows.length ? rows : next
  }

  // An upsert can move a row, so the stale copy goes first.
  const next = rows.filter((row) => row.id !== frame.record.id)
  let place: number
  if (frame.afterId === null) {
    place = 0
  } else {
    const anchor = next.findIndex((row) => row.id === frame.afterId)
    place = anchor === -1 ? next.length : anchor + 1
  }
  next.splice(place, 0, frame.record)
  return next
}
```

`src/live/sse.ts`:

```ts
/**
 * The SSE frames of one response body, decoded as JSON.
 *
 * A live view carries JSON in `data:` lines; keepalive comments and event
 * names never surface. Written here rather than taken from a library so the
 * browser entry point keeps zero dependencies.
 */
export async function* parseSseFrames<TFrame>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<TFrame, void, void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let data: string[] = []

  const flush = (): TFrame | undefined => {
    if (data.length === 0) return undefined
    const frame = JSON.parse(data.join('\n')) as TFrame
    data = []
    return frame
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const frame = flush()
          if (frame !== undefined) yield frame
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
        }
      }
    }
    const frame = flush()
    if (frame !== undefined) yield frame
  } finally {
    await reader.cancel().catch(() => {})
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/bunderstack && bun test src/live/`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/live/apply.ts packages/bunderstack/src/live/sse.ts packages/bunderstack/src/live/apply.test.ts packages/bunderstack/src/live/sse.test.ts
git commit -m "feat(live): add the client-side frame fold and SSE reader"
```

---

### Task 7: The client view

**Files:**
- Create: `packages/bunderstack/src/live/index.ts`
- Modify: `packages/bunderstack/package.json` (add the `./live` export)
- Modify: `scripts/bundle-boundaries.test.ts`
- Test: `packages/bunderstack/src/live/live-view.test.ts`

**Interfaces:**
- Consumes: `applyLiveFrame`, `parseSseFrames` (Task 6), `LiveFrame`, `LiveInput` (Task 2).
- Produces: `createLiveView<T extends { id: string }>(url: string, options?: CreateLiveViewOptions): LiveView<T>`, `LiveStatus`, and re-exports of the protocol types and `applyLiveFrame`.

- [ ] **Step 1: Write the failing test**

`src/live/live-view.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { createLiveView } from './index'

type Row = { id: string; title: string }

function sseResponse(chunks: string[], hold = false): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        if (!hold) controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

const snapshot = frame({
  type: 'snapshot',
  items: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ],
  sort: 'id',
  order: 'asc',
  limit: 100,
  hasMore: false,
})

/** Waits until `check` holds, or fails the test. */
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('the view fills from the snapshot and applies deltas', async () => {
  const view = createLiveView<Row>('/api/posts:live', {
    fetch: async () =>
      sseResponse(
        [snapshot, frame({ type: 'upsert', record: { id: 'c', title: 'C' }, afterId: 'a' })],
        true,
      ),
  })
  let notifications = 0
  view.subscribe(() => notifications++)

  await until(() => view.getRows().length === 3, 'three rows')
  expect(view.getRows().map((row) => row.id)).toEqual(['a', 'c', 'b'])
  expect(view.getStatus()).toBe('live')
  expect(notifications).toBeGreaterThanOrEqual(2)
  view.close()
})

test('the request carries the input as query parameters', async () => {
  const seen: string[] = []
  const view = createLiveView<Row>('/api/posts:live', {
    input: { limit: 10, sort: 'rank', order: 'desc', filters: { userId: 'u1' } },
    fetch: async (input) => {
      seen.push(String(input))
      return sseResponse([snapshot], true)
    },
  })
  await until(() => seen.length === 1, 'one request')
  const url = new URL(seen[0]!, 'http://test')
  expect(url.searchParams.get('limit')).toBe('10')
  expect(url.searchParams.get('sort')).toBe('rank')
  expect(url.searchParams.get('order')).toBe('desc')
  expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ userId: 'u1' })
  view.close()
})

test('a dropped stream reconnects and the new snapshot heals the view', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/posts:live', {
    backoff: () => 0,
    fetch: async () => {
      attempts++
      // The first connection ends after one frame; the second holds open.
      return attempts === 1
        ? sseResponse([frame({ type: 'remove', id: 'zzz' })])
        : sseResponse([snapshot], true)
    },
  })
  await until(() => view.getRows().length === 2, 'the healed view')
  expect(attempts).toBeGreaterThanOrEqual(2)
  expect(view.getStatus()).toBe('live')
  view.close()
})

test('a first failure reports failed; a later one reports reconnecting', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/posts:live', {
    backoff: () => 5,
    fetch: async () => {
      attempts++
      if (attempts === 1) return new Response('nope', { status: 500 })
      return sseResponse([snapshot])
    },
  })
  await until(() => view.getStatus() === 'failed', 'the failed status')
  expect(view.getError()).toBeDefined()
  await until(() => view.getStatus() === 'reconnecting', 'the reconnect status')
  expect(view.getRows().length).toBe(2)
  view.close()
})

test('patch writes optimistically and notifies once', async () => {
  const view = createLiveView<Row>('/api/posts:live', {
    fetch: async () => sseResponse([snapshot], true),
  })
  await until(() => view.getRows().length === 2, 'the snapshot')
  let notifications = 0
  view.subscribe(() => notifications++)
  view.patch((rows) => {
    rows[0] = { ...rows[0]!, title: 'edited' }
  })
  expect(view.getRows()[0]!.title).toBe('edited')
  expect(notifications).toBe(1)
  view.close()
})

test('close stops the loop', async () => {
  let attempts = 0
  const view = createLiveView<Row>('/api/posts:live', {
    backoff: () => 0,
    fetch: async () => {
      attempts++
      return sseResponse([snapshot])
    },
  })
  await until(() => attempts >= 1, 'the first request')
  view.close()
  const settled = attempts
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(attempts).toBe(settled)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/live/live-view.test.ts`
Expected: FAIL — `createLiveView` is not exported.

- [ ] **Step 3: Write the implementation**

`src/live/index.ts`:

```ts
import type { LiveFrame, LiveInput } from './protocol'

import { applyLiveFrame } from './apply'
import { parseSseFrames } from './sse'

export type {
  LiveDeltaFrame,
  LiveFrame,
  LiveHeartbeatFrame,
  LiveInput,
  LiveRemoveFrame,
  LiveSnapshotFrame,
  LiveUpsertFrame,
} from './protocol'
export { applyLiveFrame } from './apply'
export { parseSseFrames } from './sse'

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'failed'

export type LiveView<TRow extends { id: string }> = {
  /** The current rows. A new array appears only when the view changes. */
  getRows: () => readonly TRow[]
  getStatus: () => LiveStatus
  getError: () => unknown
  /** Register a listener; the return value removes it. */
  subscribe: (listener: () => void) => () => void
  /**
   * Write to the view before the server confirms. Replace a row rather than
   * mutating it, so consumers that compare by identity see the change:
   * `patch((rows) => { rows[0] = { ...rows[0], done: true } })`.
   * The server echo replaces the write; `resync()` discards it.
   */
  patch: (recipe: (rows: TRow[]) => void) => void
  /** Reconnect. The new snapshot is the resynchronisation. */
  resync: () => void
  /** Stop the loop and abort the request. */
  close: () => void
}

export type CreateLiveViewOptions = {
  input?: LiveInput
  /** For tests and for a non-global fetch (a custom base URL, credentials). */
  fetch?: typeof fetch
  /** Delay before retry number `attempt`, counted from zero. */
  backoff?: (attempt: number) => number
}

/** Full jitter, the same shape the realtime client uses. */
const defaultBackoff = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(30_000, 1_000 * 2 ** attempt))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function buildUrl(url: string, input: LiveInput | undefined): string {
  if (!input) return url
  const params = new URLSearchParams()
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  if (input.sort) params.set('sort', input.sort)
  if (input.order) params.set('order', input.order)
  if (input.filters && Object.keys(input.filters).length > 0) {
    params.set('filters', JSON.stringify(input.filters))
  }
  return params.size > 0 ? `${url}?${params}` : url
}

/**
 * One live view: a reconnecting loop over `GET /api/{table}:live` that folds
 * frames into an immutable array of rows.
 *
 * The view holds no cache and no second copy of the data. Every connection
 * opens with a snapshot, so a reconnect is the resynchronisation, and the
 * server places each row, so this module never sorts.
 *
 * `subscribe` plus `getRows` is the shape `useSyncExternalStore` expects; a
 * Solid or Vue binding writes `getRows()` into a store from the same listener.
 */
export function createLiveView<TRow extends { id: string }>(
  url: string,
  options: CreateLiveViewOptions = {},
): LiveView<TRow> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const backoff = options.backoff ?? defaultBackoff
  const listeners = new Set<() => void>()

  let rows: readonly TRow[] = []
  let status: LiveStatus = 'connecting'
  let error: unknown
  let closed = false
  let controller: AbortController | undefined

  const notify = () => {
    for (const listener of listeners) listener()
  }

  void (async () => {
    let attempt = 0
    while (!closed) {
      controller = new AbortController()
      try {
        const response = await fetchImpl(buildUrl(url, options.input), {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        })
        if (!response.ok || !response.body) {
          throw new Error(`live request failed (${response.status})`)
        }
        for await (const frame of parseSseFrames<LiveFrame<TRow>>(
          response.body,
        )) {
          attempt = 0
          const next = applyLiveFrame(rows, frame)
          const changed = next !== rows || status !== 'live' || error !== undefined
          rows = next
          status = 'live'
          error = undefined
          if (changed) notify()
        }
        // A live view never ends on its own; reaching here is a drop.
        throw new Error('live stream closed')
      } catch (cause) {
        if (closed) return
        error = cause
        // Rows on screen mean the view still works while it reconnects.
        status = rows.length > 0 ? 'reconnecting' : 'failed'
        notify()
        await sleep(backoff(attempt++))
      }
    }
  })()

  return {
    getRows: () => rows,
    getStatus: () => status,
    getError: () => error,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    patch: (recipe) => {
      const draft = [...rows]
      recipe(draft)
      rows = draft
      notify()
    },
    resync: () => {
      controller?.abort()
    },
    close: () => {
      closed = true
      controller?.abort()
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/bunderstack && bun test src/live/`
Expected: PASS.

- [ ] **Step 5: Add the package export**

In `packages/bunderstack/package.json`, add to `exports`, keeping the keys sorted as the file has them:

```json
    "./live": {
      "types": "./dist/live/index.d.ts",
      "default": "./dist/live/index.js"
    },
```

- [ ] **Step 6: Add the bundle boundary test**

Append a case to the `describe('browser bundle boundaries')` block in `scripts/bundle-boundaries.test.ts`:

```ts
  test('the live view client stays browser-only and dependency-free', async () => {
    const output = await bundle('packages/bunderstack/src/live/index.ts')
    expect(output.size).toBeLessThan(8 * 1024)
    expectNoBundleInputs(output.inputs, [
      '/drizzle-orm/',
      '/better-auth/',
      '/valibot/',
      'packages/bunderstack/src/api',
      'packages/bunderstack/src/index.ts',
    ])
    expect(output.text).not.toContain('@orpc/')
  })
```

- [ ] **Step 7: Run the contract tests**

Run: `bun test scripts/bundle-boundaries.test.ts scripts/packaging-contract.test.ts scripts/dependency-boundaries.test.ts`
Expected: PASS. If `packaging-contract.test.ts` enumerates the export map, add `./live` to its expectation.

- [ ] **Step 8: Commit**

```bash
git add packages/bunderstack/src/live/index.ts packages/bunderstack/src/live/live-view.test.ts packages/bunderstack/package.json scripts/bundle-boundaries.test.ts
git commit -m "feat(live): add the bunderstack/live browser client"
```

---

### Task 8: Build, typecheck, and documentation

**Files:**
- Modify: `packages/bunderstack/README.md` or the root `README.md` (whichever documents realtime)
- Modify: `CHANGELOG.md`
- Modify: `docs/` entries that list subpath exports, if the contract tests demand it

- [ ] **Step 1: Prove the package builds and typechecks**

Run: `cd packages/bunderstack && bun run build && bun run typecheck`
Expected: PASS, and `dist/live/index.js` plus `dist/live/index.d.ts` exist.

- [ ] **Step 2: Run the whole suite**

Run: `bun test` from the repository root.
Expected: PASS. Fix any contract test that enumerates exports, routes, or documentation.

- [ ] **Step 3: Document the feature**

Add a section after the realtime section of the README:

````md
### Live views

`GET /api/{table}:live` is one list query as a stream. It opens with a snapshot
of the result and then sends only the changes that belong to that result: the
server decides membership against the view's filters and places each row, so the
browser holds no cache and never repeats the sort.

```ts
import { createLiveView } from 'bunderstack/live'

const view = createLiveView<Todo>('/api/todos:live', {
  input: { sort: 'createdAt', order: 'desc', limit: 100 },
})

view.subscribe(() => render(view.getRows(), view.getStatus()))
```

Every connection starts with a snapshot, so a reconnect is the
resynchronisation — there is no event buffer and no refetch path. A live view
accepts `limit`, `sort`, `order`, and `filters`; `q`, `offset`, and `cursor`
belong to `GET /api/{table}`, because a stream cannot decide text search or
pagination from one record.

Reading a live view needs the table's `list` right, which also gates every
change the stream delivers.
````

- [ ] **Step 4: Add the changelog entry**

Add under the unreleased heading, following the file's existing style:

```md
- Live views: `GET /api/{table}:live` streams a snapshot of a list query and
  then server-placed `upsert`/`remove` frames. The new `bunderstack/live`
  subpath holds a zero-dependency browser client for it.
```

- [ ] **Step 5: Run the whole suite once more**

Run: `bun test` from the repository root.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md docs
git commit -m "docs: document live views"
```
