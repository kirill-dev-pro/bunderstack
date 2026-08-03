# Kanban + Realtime + Access-Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two reusable bunderstack core features — declarative access `scope` (multi-tenant row scoping) and PocketBase-style SSE realtime — then ship a Trello-like kanban example that showcases them with Solid 2 + Vite + Oat.

**Architecture:** `scope` is an equality-map resolver evaluated identically as SQL (list `WHERE`) and in-memory (get/write + realtime delivery), so REST and realtime auth never drift and per-event authorization needs zero DB round-trips. Realtime is an in-memory broker that crud publishes to on every write; an SSE endpoint (`GET/POST /api/realtime`) delivers `{action, table, record}` to subscribers whose `get` rule + scope admit the row. The example is a Solid SPA talking to a standalone `Bun.serve` mount via `@tanstack/solid-query`, with a framework-agnostic realtime client (in `bunderstack-query`) wiring events into the query cache.

**Tech Stack:** Bun, Drizzle, libSQL, Hono, BetterAuth (+ `organization` plugin), Solid 2 (beta), Vite, Oat, `@tanstack/solid-query`, `@thisbeyond/solid-dnd`.

## Global Constraints

- Runtime is **Bun**; use `bun test`, `bun <file>`, `bun install`. Never Node/npm/jest/vitest.
- Core packages (`packages/bunderstack`, `packages/bunderstack-query`) must stay **framework-agnostic** — no React/Solid imports in core. The realtime client takes a `QueryClient` and (optionally) an `EventSource` impl by injection.
- New core source files use the existing style: `.ts` extension on relative imports, `customType`/drizzle re-exports from `bunderstack`, 2-space indent, no semicolons (match `.oxfmtrc.json`).
- All example app tables use `typeid('<prefix>')` for `id` and carry a denormalized `organizationId` (text) column.
- Scope authorization must be a pure property comparison (no DB) so realtime stays cheap. No `Last-Event-ID` replay in v1.
- Solid 2 is beta — follow the migration guide at https://raw.githubusercontent.com/solidjs/solid/refs/heads/next/documentation/solid-2.0/MIGRATION.md when an API differs from Solid 1.
- Commit after every task. Work happens on branch `kanban-realtime` (already created).

---

## File Structure

**Core: `packages/bunderstack/src/`**

- `access.ts` (modify) — add `ScopeMap`, `ScopeResolver`, `scope` on access config, `session` on `AccessContext`, `rowMatchesScope`, `resolveSession`, `stampScope`.
- `scope.ts` (create) — `buildScopeWhere(table, scopeMap)` Drizzle helper (kept out of `access.ts` to avoid a drizzle import there).
- `list-query.ts` (modify) — `executeList` accepts an optional `scopeWhere` SQL and ANDs it in.
- `crud.ts` (modify) — resolve session, apply scope on list/get/create/update/delete, publish realtime events.
- `realtime.ts` (create) — in-memory broker: `createRealtimeBroker`, `publish`, subscriber registry, `buildRealtimeRouter` (SSE GET + POST).
- `config.ts` (modify) — loosen `access` zod schema to allow functions; add `realtime` option.
- `index.ts` (modify) — construct broker, wire into crud + handler.
- `handler.ts` (modify) — mount the realtime router.

**Core client: `packages/bunderstack-query/src/`**

- `realtime-client.ts` (create) — `createRealtimeClient({ baseUrl, queryClient, tables, fetch?, EventSourceImpl? })`.
- `index.ts` (modify) — export it.

**Example: `examples/kanban/`**

- `package.json`, `tsconfig.json`, `vite.config.ts`, `drizzle.config.ts`, `index.html`, `.env.example`
- `src/schema.ts`, `src/access.ts`, `src/server.ts`, `scripts/seed.ts`
- `src/lib/` — `auth-client.ts`, `query.ts`, `oat.ts`
- `src/app.tsx`, `src/index.tsx`, `src/routes/` (`Login.tsx`, `Boards.tsx`, `Board.tsx`), `src/components/` (`ListColumn.tsx`, `CardItem.tsx`, `CardDialog.tsx`, `Members.tsx`)
- `README.md`; update `examples/README.md`.

---

# Phase A — Core feature: Access `scope`

### Task A1: Scope types, session context, and `rowMatchesScope`

**Files:**

- Modify: `packages/bunderstack/src/access.ts`
- Test: `packages/bunderstack/src/scope.test.ts`

**Interfaces:**

- Produces:
  - `type ScopeMap = Record<string, string | string[]>`
  - `type ScopeResolver = (ctx: AccessContext) => ScopeMap`
  - `AccessContext.session?: { activeOrganizationId: string | null } | null`
  - `TableAccessInput.scope?: ScopeResolver`, `ResolvedTableAccess.scope?: ScopeResolver`
  - `rowMatchesScope(row: Record<string, unknown>, scope: ScopeMap): boolean`
  - `resolveSession(auth, headers): Promise<{ user: AccessUser | null; activeOrganizationId: string | null }>`
  - `stampScope(values: Record<string, unknown>, scope: ScopeMap): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack/src/scope.test.ts
import { describe, it, expect } from 'bun:test'
import { rowMatchesScope, stampScope } from './access.ts'

describe('rowMatchesScope', () => {
  it('matches single-value scope', () => {
    expect(
      rowMatchesScope({ organizationId: 'org_1' }, { organizationId: 'org_1' }),
    ).toBe(true)
    expect(
      rowMatchesScope({ organizationId: 'org_2' }, { organizationId: 'org_1' }),
    ).toBe(false)
  })
  it('matches array (membership) scope', () => {
    expect(
      rowMatchesScope(
        { organizationId: 'org_2' },
        { organizationId: ['org_1', 'org_2'] },
      ),
    ).toBe(true)
    expect(
      rowMatchesScope(
        { organizationId: 'org_9' },
        { organizationId: ['org_1', 'org_2'] },
      ),
    ).toBe(false)
  })
  it('fails when the scoped column is missing/null', () => {
    expect(rowMatchesScope({}, { organizationId: 'org_1' })).toBe(false)
  })
  it('requires all keys to match', () => {
    expect(
      rowMatchesScope(
        { organizationId: 'org_1', userId: 'u_2' },
        { organizationId: 'org_1', userId: 'u_1' },
      ),
    ).toBe(false)
  })
})

describe('stampScope', () => {
  it('overwrites single-value scope columns, ignores arrays', () => {
    expect(
      stampScope(
        { title: 'x', organizationId: 'spoofed' },
        { organizationId: 'org_1' },
      ),
    ).toEqual({ title: 'x', organizationId: 'org_1' })
    expect(
      stampScope({ title: 'x' }, { organizationId: ['org_1', 'org_2'] }),
    ).toEqual({ title: 'x' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/scope.test.ts`
Expected: FAIL — `rowMatchesScope`/`stampScope` not exported.

- [ ] **Step 3: Add types and helpers to `access.ts`**

In `access.ts`, extend `AccessContext`:

```ts
export type AccessContext = {
  user: AccessUser | null
  request: Request
  row?: Record<string, unknown>
  body?: Record<string, unknown>
  session?: { activeOrganizationId: string | null } | null
}
```

Add after the `OperationRule` type:

```ts
export type ScopeMap = Record<string, string | string[]>
export type ScopeResolver = (ctx: AccessContext) => ScopeMap
```

Add `scope?: ScopeResolver` to both `TableAccessInput` and `ResolvedTableAccess`.

Add these exported functions near `checkAccess`:

```ts
export function rowMatchesScope(
  row: Record<string, unknown>,
  scope: ScopeMap,
): boolean {
  for (const [col, expected] of Object.entries(scope)) {
    const actual = row[col]
    if (actual == null) return false
    if (Array.isArray(expected)) {
      if (!expected.map(String).includes(String(actual))) return false
    } else if (String(actual) !== String(expected)) {
      return false
    }
  }
  return true
}

export function stampScope(
  values: Record<string, unknown>,
  scope: ScopeMap,
): Record<string, unknown> {
  const out = { ...values }
  for (const [col, expected] of Object.entries(scope)) {
    if (!Array.isArray(expected)) out[col] = expected
  }
  return out
}
```

In `resolveDefaults`, thread `scope` through the returned object: add `scope: input.scope,` to the returned object literal.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/bunderstack/src/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `resolveSession` and test it**

Append to `scope.test.ts`:

```ts
import { resolveSession } from './access.ts'

describe('resolveSession', () => {
  it('returns null user and org when no auth', async () => {
    expect(await resolveSession(undefined, new Headers())).toEqual({
      user: null,
      activeOrganizationId: null,
    })
  })
  it('extracts activeOrganizationId from the session', async () => {
    const auth = {
      api: {
        getSession: async () => ({
          user: { id: 'u_1', email: 'a@b.c', name: 'A' },
          session: { activeOrganizationId: 'org_1' },
        }),
      },
    }
    expect(await resolveSession(auth as never, new Headers())).toEqual({
      user: { id: 'u_1', email: 'a@b.c', name: 'A' },
      activeOrganizationId: 'org_1',
    })
  })
})
```

In `access.ts`, widen `AuthSessionResolver`:

```ts
export type AuthSessionResolver = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{
      user: { id: string; email: string; name?: string } | null
      session?: { activeOrganizationId?: string | null } | null
    } | null>
  }
}
```

Add:

```ts
export async function resolveSession(
  auth: AuthSessionResolver | undefined,
  headers: Headers,
): Promise<{ user: AccessUser | null; activeOrganizationId: string | null }> {
  if (!auth) return { user: null, activeOrganizationId: null }
  const session = await auth.api.getSession({ headers })
  if (!session?.user) return { user: null, activeOrganizationId: null }
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
    activeOrganizationId: session.session?.activeOrganizationId ?? null,
  }
}
```

- [ ] **Step 6: Run tests**

Run: `bun test packages/bunderstack/src/scope.test.ts`
Expected: PASS (all 6).

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/access.ts packages/bunderstack/src/scope.test.ts
git commit -m "feat(core): access scope types, rowMatchesScope, stampScope, resolveSession"
```

---

### Task A2: `buildScopeWhere` + list scoping

**Files:**

- Create: `packages/bunderstack/src/scope.ts`
- Modify: `packages/bunderstack/src/list-query.ts`
- Test: `packages/bunderstack/src/scope-where.test.ts`

**Interfaces:**

- Consumes: `ScopeMap` (Task A1).
- Produces: `buildScopeWhere(table, scope: ScopeMap): SQL | undefined`; `executeList(..., scopeWhere?: SQL)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack/src/scope-where.test.ts
import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { buildScopeWhere } from './scope.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
})

describe('buildScopeWhere', () => {
  it('returns a condition for single value', () => {
    expect(buildScopeWhere(boards, { organizationId: 'org_1' })).toBeDefined()
  })
  it('returns a condition for array value', () => {
    expect(
      buildScopeWhere(boards, { organizationId: ['org_1', 'org_2'] }),
    ).toBeDefined()
  })
  it('returns undefined for empty scope', () => {
    expect(buildScopeWhere(boards, {})).toBeUndefined()
  })
  it('skips unknown columns', () => {
    expect(buildScopeWhere(boards, { nope: 'x' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/scope-where.test.ts`
Expected: FAIL — module `./scope.ts` not found.

- [ ] **Step 3: Create `scope.ts`**

```ts
// packages/bunderstack/src/scope.ts
import { and, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm'

import type { ScopeMap } from './access.ts'

export function buildScopeWhere(
  table: Parameters<typeof getTableColumns>[0],
  scope: ScopeMap,
): SQL | undefined {
  const columns = getTableColumns(table)
  const conditions: SQL[] = []
  for (const [name, value] of Object.entries(scope)) {
    const col = columns[name]
    if (!col) continue
    conditions.push(Array.isArray(value) ? inArray(col, value) : eq(col, value))
  }
  return conditions.length ? and(...conditions) : undefined
}
```

- [ ] **Step 4: Thread `scopeWhere` into `executeList`**

In `list-query.ts`, change the `executeList` signature to accept an optional trailing `scopeWhere?: SQL`:

```ts
export async function executeList<T extends Record<string, unknown>>(
  db: LibSQLDatabase<Record<string, unknown>>,
  table: Parameters<typeof getTableColumns>[0],
  access: ResolvedTableAccess,
  params: ParsedListParams,
  idCol: unknown,
  scopeWhere?: SQL,
): Promise<ListResult<T>> {
```

Then where `let where = and(...)` is built, AND in `scopeWhere`:

```ts
let where = and(
  ...(searchWhere ? [searchWhere] : []),
  ...(filterWhere ? [filterWhere] : []),
  ...(scopeWhere ? [scopeWhere] : []),
)
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/bunderstack/src/scope-where.test.ts`
Expected: PASS (4).

- [ ] **Step 6: Run the full core suite to confirm no regression**

Run: `bun test packages/bunderstack`
Expected: PASS (existing tests still green; `executeList`'s new arg is optional).

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/scope.ts packages/bunderstack/src/scope-where.test.ts packages/bunderstack/src/list-query.ts
git commit -m "feat(core): buildScopeWhere and optional scope filter in executeList"
```

---

### Task A3: Loosen access zod schema + add `realtime` option

**Files:**

- Modify: `packages/bunderstack/src/config.ts`
- Test: `packages/bunderstack/src/config-access.test.ts`

**Interfaces:**

- Produces: config parsing accepts function rules + `scope` function; `BunderstackConfig.realtime?: boolean | { keepaliveMs?: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack/src/config-access.test.ts
import { describe, it, expect } from 'bun:test'
import { resolveConfig } from './config.ts'

describe('resolveConfig with function access rules', () => {
  it('does not throw when access uses functions and scope', () => {
    expect(() =>
      resolveConfig({
        schema: {},
        access: {
          boards: {
            list: () => true,
            scope: (ctx) => ({
              organizationId: ctx.session?.activeOrganizationId ?? '',
            }),
          },
        },
        realtime: true,
      } as never),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/config-access.test.ts`
Expected: FAIL — zod rejects the function for `list` (enum) / unknown `scope` key.

- [ ] **Step 3: Loosen the access schema and add `realtime`**

In `config.ts`, replace the `access` entry of `BunderstackOptionsSchema` with a permissive record (real validation already lives in `validateAndResolveAccess`):

```ts
  access: z.record(z.string(), z.any()).optional(),
```

Add a `realtime` field to `BunderstackOptionsSchema`:

```ts
  realtime: z
    .union([z.boolean(), z.object({ keepaliveMs: z.number().optional() })])
    .optional(),
```

Add to the `BunderstackConfig` type (the re-typed object after `Omit`):

```ts
  realtime?: boolean | { keepaliveMs?: number }
```

(Keep `access?: Record<string, TableAccessInput>` typed via the import from `./access.ts`.)

- [ ] **Step 4: Run tests**

Run: `bun test packages/bunderstack/src/config-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/config-access.test.ts
git commit -m "feat(core): allow function access rules + scope; add realtime config option"
```

---

### Task A4: Enforce scope in crud (list/get/create/update/delete)

**Files:**

- Modify: `packages/bunderstack/src/crud.ts`
- Test: `packages/bunderstack/src/crud-scope.test.ts`

**Interfaces:**

- Consumes: `resolveSession`, `rowMatchesScope`, `stampScope` (A1), `buildScopeWhere` (A2).
- Produces: scoped behavior on all five operations. `CrudRouterOptions.broker?` is added here as an unused field (used in Phase B) to avoid touching this signature twice — set to `import('./realtime.ts').RealtimeBroker | undefined`.

This task wires scope. **Replace each `resolveAccessUser(auth, ...)` call in `crud.ts` with `resolveSession`** and pass `session` into the access context.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack/src/crud-scope.test.ts
import { describe, it, expect, beforeAll } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { buildCrudRouter } from './crud.ts'
import { validateAndResolveAccess } from './access.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }

function authFor(orgId: string | null) {
  return {
    api: {
      getSession: async () => ({
        user: { id: 'u_1', email: 'a@b.c', name: 'A' },
        session: { activeOrganizationId: orgId },
      }),
    },
  }
}

async function makeRouter(orgId: string | null) {
  const client = createClient({ url: ':memory:' })
  await client.execute(
    'CREATE TABLE boards (id text primary key, organization_id text not null, title text not null)',
  )
  await client.execute(
    "INSERT INTO boards VALUES ('b1','org_1','One'),('b2','org_2','Two')",
  )
  const db = drizzle(client, { schema })
  const access = validateAndResolveAccess(schema, {
    boards: {
      list: 'authenticated',
      get: 'authenticated',
      create: 'authenticated',
      update: 'authenticated',
      delete: 'authenticated',
      scope: (ctx) => ({
        organizationId: ctx.session?.activeOrganizationId ?? '',
      }),
    },
  })
  return buildCrudRouter(schema, db as never, {
    auth: authFor(orgId) as never,
    access,
  })
}

describe('crud scope', () => {
  it('list only returns rows in the active org', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(new Request('http://x/boards'))
    const body = await res.json()
    expect(body.items.map((b: { id: string }) => b.id)).toEqual(['b1'])
  })
  it('get of an out-of-scope row is 404', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(new Request('http://x/boards/b2'))
    expect(res.status).toBe(404)
  })
  it('create stamps the active org, ignoring a spoofed organizationId', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(
      new Request('http://x/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'b3',
          title: 'New',
          organizationId: 'org_2',
        }),
      }),
    )
    const body = await res.json()
    expect(body.organizationId).toBe('org_1')
  })
  it('update of an out-of-scope row is 404', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(
      new Request('http://x/boards/b2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked' }),
      }),
    )
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/crud-scope.test.ts`
Expected: FAIL — list returns both rows; get/update return 200.

- [ ] **Step 3: Implement scope in crud**

In `crud.ts`:

a. Update imports from `./access.ts` to add `resolveSession`, `rowMatchesScope`, `stampScope` and from `./scope.ts` add `buildScopeWhere`. Add `type ScopeMap` import.

b. Add `broker?` to `CrudRouterOptions`:

```ts
import type { RealtimeBroker } from './realtime.ts'
export type CrudRouterOptions = {
  auth?: AuthSessionResolver
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  broker?: RealtimeBroker
}
```

c. Add a helper near the top of `buildCrudRouter` body (before the `for` loop) — a local that builds the AccessContext scope for a table:

```ts
const scopeFor = (
  tableAccess: ResolvedTableAccess,
  ctx: {
    user: AccessUser | null
    session: { activeOrganizationId: string | null } | null
    request: Request
  },
): ScopeMap | undefined =>
  tableAccess.scope ? tableAccess.scope({ ...ctx }) : undefined
```

(Import `AccessUser` and `ScopeMap` types from `./access.ts`.)

d. **list handler:** replace `const user = await resolveAccessUser(auth, c.req.raw.headers)` with:

```ts
const { user, activeOrganizationId } = await resolveSession(
  auth,
  c.req.raw.headers,
)
const session = { activeOrganizationId }
```

Pass `session` into the `enforce('list', ...)` ctx. After computing `params`, compute scope and pass `scopeWhere`:

```ts
const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
const scopeWhere = scope ? buildScopeWhere(table, scope) : undefined
const result = await executeList(db as ..., table, tableAccess, params, idCol, scopeWhere)
```

e. **get handler:** use `resolveSession`, pass `session` to `enforce('get', ...)`. After the `enforce` allow-check, add:

```ts
const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
if (scope && !rowMatchesScope(rows[0] as Record<string, unknown>, scope)) {
  return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
}
```

f. **post (create) handler:** use `resolveSession`/`session`. After `sanitizeWriteBody(...)` produces `values`, stamp scope:

```ts
const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
const stamped = scope ? stampScope(values, scope) : values
const rows = await (db as any).insert(table).values(stamped).returning()
```

(Use `stamped` for the insert.)

g. **patch (update) handler:** use `resolveSession`/`session`. After loading `existing[0]` and before/with the `enforce('update', ...)`, add a scope check that returns 404 for out-of-scope rows:

```ts
const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
if (scope && !rowMatchesScope(existing[0] as Record<string, unknown>, scope)) {
  return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
}
```

h. **delete handler:** same as update — `resolveSession`/`session` + the out-of-scope 404 check on `existing[0]`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/bunderstack/src/crud-scope.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Run the full core suite**

Run: `bun test packages/bunderstack`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/crud.ts packages/bunderstack/src/crud-scope.test.ts
git commit -m "feat(core): enforce access scope on list/get/create/update/delete"
```

---

# Phase B — Core feature: Realtime

### Task B1: In-memory realtime broker

**Files:**

- Create: `packages/bunderstack/src/realtime.ts`
- Test: `packages/bunderstack/src/realtime.test.ts`

**Interfaces:**

- Consumes: `ResolvedAccess`, `tableEntryForName` semantics, `checkAccess`, `rowMatchesScope`, `AccessUser` (A1).
- Produces:
  - `type RealtimeAction = 'create' | 'update' | 'delete'`
  - `type RealtimeBroker` with:
    - `register(send: (data: string) => void): Subscriber` (returns `{ id }` + handle)
    - `setContext(id, { user, activeOrganizationId, subscriptions })`
    - `unregister(id)`
    - `publish(table: string, action: RealtimeAction, record: Record<string, unknown>): void`
  - `createRealtimeBroker(opts: { access: ResolvedAccess }): RealtimeBroker`

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack/src/realtime.test.ts
import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { validateAndResolveAccess } from './access.ts'
import { createRealtimeBroker } from './realtime.ts'

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
    scope: (ctx) => ({
      organizationId: ctx.session?.activeOrganizationId ?? '',
    }),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/realtime.test.ts`
Expected: FAIL — `./realtime.ts` not found.

- [ ] **Step 3: Implement the broker**

```ts
// packages/bunderstack/src/realtime.ts
import {
  checkAccess,
  rowMatchesScope,
  type AccessUser,
  type ResolvedAccess,
  type ResolvedTableAccess,
} from './access.ts'

export type RealtimeAction = 'create' | 'update' | 'delete'

type Subscriber = {
  id: string
  send: (data: string) => void
  user: AccessUser | null
  activeOrganizationId: string | null
  subscriptions: Set<string>
}

export type RealtimeBroker = {
  register(send: (data: string) => void): { id: string }
  setContext(
    id: string,
    ctx: {
      user: AccessUser | null
      activeOrganizationId: string | null
      subscriptions: Set<string>
    },
  ): void
  unregister(id: string): void
  publish(
    table: string,
    action: RealtimeAction,
    record: Record<string, unknown>,
  ): void
}

function tableEntry(
  access: ResolvedAccess,
  tableName: string,
): ResolvedTableAccess | undefined {
  for (const entry of access.values()) {
    if (entry.tableName === tableName) return entry
  }
  return undefined
}

export function createRealtimeBroker(opts: {
  access: ResolvedAccess
}): RealtimeBroker {
  const subscribers = new Map<string, Subscriber>()

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
      if (!s) return
      s.user = ctx.user
      s.activeOrganizationId = ctx.activeOrganizationId
      s.subscriptions = ctx.subscriptions
    },
    unregister(id) {
      subscribers.delete(id)
    },
    publish(table, action, record) {
      const entry = tableEntry(opts.access, table)
      if (!entry) return
      const id = record['id']
      const payload = JSON.stringify({ action, table, record })

      for (const s of subscribers.values()) {
        const topicMatch =
          s.subscriptions.has(table) ||
          (id != null && s.subscriptions.has(`${table}/${String(id)}`))
        if (!topicMatch) continue

        const ctx = {
          user: s.user,
          request: new Request('http://realtime.local'),
          row: record,
          session: { activeOrganizationId: s.activeOrganizationId },
        }
        // get-rule gate (sync-safe for non-function rules; function rules are awaited-as-truthy)
        const ruleResult = checkAccess(entry.get, ctx, entry.ownerColumn)
        const allowed =
          ruleResult instanceof Promise ? false : ruleResult.allowed
        if (ruleResult instanceof Promise) {
          ruleResult.then((r) => {
            if (r.allowed && scopeOk(entry, ctx, record)) s.send(payload)
          })
          continue
        }
        if (!allowed) continue
        if (!scopeOk(entry, ctx, record)) continue
        s.send(payload)
      }
    },
  }
}

function scopeOk(
  entry: ResolvedTableAccess,
  ctx: Parameters<typeof checkAccess>[1],
  record: Record<string, unknown>,
): boolean {
  if (!entry.scope) return true
  return rowMatchesScope(record, entry.scope(ctx))
}
```

Note: `checkAccess` returns a `Promise` only for function rules; for the common enum rules it returns synchronously, so delivery is sync. (`checkAccess` already returns `Promise<...>` typed — wrap the call so the sync path works: change the call to `const ruleResult = checkAccess(...)` where `checkAccess` for non-function rules resolves immediately. If `checkAccess` always returns a Promise in the current code, instead `await` it inside an async IIFE per subscriber — simplest correct form below.)

If `checkAccess` is always async in the current code, replace the per-subscriber block with:

```ts
void (async () => {
  const r = await checkAccess(entry.get, ctx, entry.ownerColumn)
  if (r.allowed && scopeOk(entry, ctx, record)) s.send(payload)
})()
```

and keep the test deterministic by `await`ing a microtask — but to keep tests synchronous, prefer making `checkAccess` for enum rules return synchronously. **Decision for this task:** add a synchronous sibling `checkAccessSync(rule, ctx, ownerColumn)` in `access.ts` that throws if `rule` is a function, and use it in the broker (realtime only supports enum/scope rules, which is all the example needs). Add this to `access.ts`:

```ts
export function checkAccessSync(
  rule: Exclude<
    OperationRule,
    (ctx: AccessContext) => boolean | Promise<boolean>
  >,
  ctx: AccessContext,
  ownerColumn?: string,
): { allowed: boolean } {
  if (rule === 'deny') return { allowed: false }
  if (rule === 'public') return { allowed: true }
  if (!ctx.user) return { allowed: false }
  if (rule === 'authenticated') return { allowed: true }
  if (rule === 'owner') {
    if (!ownerColumn) return { allowed: false }
    const owner = ctx.row?.[ownerColumn]
    return { allowed: owner != null && String(owner) === ctx.user.id }
  }
  return { allowed: false }
}
```

Then in the broker, gate with:

```ts
if (typeof entry.get === 'function') continue // function get-rules unsupported on realtime v1
if (!checkAccessSync(entry.get, ctx, entry.ownerColumn).allowed) continue
if (!scopeOk(entry, ctx, record)) continue
s.send(payload)
```

Use this synchronous form as the final implementation (delete the Promise-handling sketch above).

- [ ] **Step 4: Run tests**

Run: `bun test packages/bunderstack/src/realtime.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/realtime.ts packages/bunderstack/src/access.ts packages/bunderstack/src/realtime.test.ts
git commit -m "feat(core): in-memory realtime broker with get-rule + scope authorization"
```

---

### Task B2: SSE router (`GET`/`POST /api/realtime`) + wiring

**Files:**

- Modify: `packages/bunderstack/src/realtime.ts` (add `buildRealtimeRouter`)
- Modify: `packages/bunderstack/src/handler.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/realtime-sse.test.ts`

**Interfaces:**

- Consumes: `RealtimeBroker` (B1), `resolveSession` (A1), `AuthSessionResolver`.
- Produces: `buildRealtimeRouter(broker, { auth, keepaliveMs }): Hono`; `HandlerParts.realtimeRouter?: Hono`; broker constructed in `index.ts` when `realtime` is set and passed to crud + handler.

- [ ] **Step 1: Write the failing test**

```ts
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
const access = validateAndResolveAccess(
  { boards },
  {
    boards: {
      list: 'authenticated',
      get: 'authenticated',
      scope: (c) => ({ organizationId: c.session?.activeOrganizationId ?? '' }),
    },
  },
)
const auth = {
  api: {
    getSession: async () => ({
      user: { id: 'u_1', email: 'a@b.c' },
      session: { activeOrganizationId: 'org_1' },
    }),
  },
}

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

    const sub = await router.fetch(
      new Request('http://x/realtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, subscriptions: ['boards'] }),
      }),
    )
    expect(sub.status).toBe(204)

    broker.publish('boards', 'create', {
      id: 'b1',
      organizationId: 'org_1',
      title: 'X',
    })
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain('"action":"create"')
    await reader.cancel()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/realtime-sse.test.ts`
Expected: FAIL — `buildRealtimeRouter` not exported.

- [ ] **Step 3: Add `buildRealtimeRouter` to `realtime.ts`**

Add imports at top: `import { Hono } from 'hono'` and `import { resolveSession, type AuthSessionResolver } from './access.ts'`. Append:

```ts
export function buildRealtimeRouter(
  broker: RealtimeBroker,
  opts: { auth?: AuthSessionResolver; keepaliveMs?: number },
): Hono {
  const router = new Hono()
  const keepaliveMs = opts.keepaliveMs ?? 30000

  router.get('/realtime', (c) => {
    const encoder = new TextEncoder()
    let handle: { id: string }
    let keepalive: ReturnType<typeof setInterval>

    const stream = new ReadableStream({
      start(controller) {
        const send = (data: string) =>
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        handle = broker.register(send)
        send(JSON.stringify({ clientId: handle.id }))
        keepalive = setInterval(
          () => controller.enqueue(encoder.encode(': ping\n\n')),
          keepaliveMs,
        )
      },
      cancel() {
        clearInterval(keepalive)
        broker.unregister(handle.id)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  router.post('/realtime', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      clientId?: string
      subscriptions?: string[]
    } | null
    if (!body?.clientId || !Array.isArray(body.subscriptions)) {
      return c.json({ error: 'clientId and subscriptions required' }, 400)
    }
    const { user, activeOrganizationId } = await resolveSession(
      opts.auth,
      c.req.raw.headers,
    )
    broker.setContext(body.clientId, {
      user,
      activeOrganizationId,
      subscriptions: new Set(body.subscriptions),
    })
    return new Response(null, { status: 204 })
  })

  return router
}
```

- [ ] **Step 4: Mount in `handler.ts`**

Add `realtimeRouter?: Hono` to `HandlerParts`, and after the storage mount:

```ts
if (parts.realtimeRouter) {
  app.route('/api', parts.realtimeRouter)
}
```

- [ ] **Step 5: Wire in `index.ts`**

After `resolvedAccess` is computed and before `buildCrudRouter`, construct the broker:

```ts
const broker = config.realtime
  ? createRealtimeBroker({ access: resolvedAccess })
  : undefined
```

(Add `import { createRealtimeBroker, buildRealtimeRouter } from './realtime.ts'` and read `realtime` from `options` — pass `config.realtime`. In `resolveConfig`, also surface `realtime`: add `realtime: parsed.realtime` to the returned `ResolvedConfig`, and add `realtime?: boolean | { keepaliveMs?: number }` to the `ResolvedConfig` type in `config.ts`.)

Pass `broker` to crud and build the realtime router:

```ts
const crudRouter = buildCrudRouter(options.schema, db, {
  auth,
  access: resolvedAccess,
  idempotency: options.idempotency,
  broker,
})
const realtimeRouter = broker
  ? buildRealtimeRouter(broker, {
      auth,
      keepaliveMs:
        typeof config.realtime === 'object'
          ? config.realtime.keepaliveMs
          : undefined,
    })
  : undefined
```

Add `realtimeRouter` to the `buildHandler({ ... })` call.

- [ ] **Step 6: Run tests**

Run: `bun test packages/bunderstack/src/realtime-sse.test.ts`
Expected: PASS (2).

- [ ] **Step 7: Run full core suite**

Run: `bun test packages/bunderstack`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/bunderstack/src/realtime.ts packages/bunderstack/src/handler.ts packages/bunderstack/src/index.ts packages/bunderstack/src/config.ts packages/bunderstack/src/realtime-sse.test.ts
git commit -m "feat(core): SSE realtime router and createBunderstack wiring"
```

---

### Task B3: Broadcast-on-write from crud

**Files:**

- Modify: `packages/bunderstack/src/crud.ts`
- Test: `packages/bunderstack/src/crud-broadcast.test.ts`

**Interfaces:**

- Consumes: `CrudRouterOptions.broker` (A4), `RealtimeBroker.publish` (B1).

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack/src/crud-broadcast.test.ts
import { describe, it, expect } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { buildCrudRouter } from './crud.ts'
import { createRealtimeBroker } from './realtime.ts'
import { validateAndResolveAccess } from './access.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }
const auth = {
  api: {
    getSession: async () => ({
      user: { id: 'u_1', email: 'a@b.c' },
      session: { activeOrganizationId: 'org_1' },
    }),
  },
}

it('publishes a create event after insert', async () => {
  const client = createClient({ url: ':memory:' })
  await client.execute(
    'CREATE TABLE boards (id text primary key, organization_id text not null, title text not null)',
  )
  const db = drizzle(client, { schema })
  const access = validateAndResolveAccess(schema, {
    boards: {
      create: 'authenticated',
      list: 'authenticated',
      get: 'authenticated',
      scope: (c) => ({ organizationId: c.session?.activeOrganizationId ?? '' }),
    },
  })
  const broker = createRealtimeBroker({ access })
  const received: unknown[] = []
  const s = broker.register((d) => received.push(JSON.parse(d)))
  broker.setContext(s.id, {
    user: { id: 'u_1', email: 'a@b.c' },
    activeOrganizationId: 'org_1',
    subscriptions: new Set(['boards']),
  })

  const router = buildCrudRouter(schema, db as never, {
    auth: auth as never,
    access,
    broker,
  })
  await router.fetch(
    new Request('http://x/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'b1', title: 'X' }),
    }),
  )

  expect(received).toContainEqual({
    action: 'create',
    table: 'boards',
    record: { id: 'b1', organizationId: 'org_1', title: 'X' },
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/crud-broadcast.test.ts`
Expected: FAIL — no event received (broker not yet published to).

- [ ] **Step 3: Publish from crud**

In `crud.ts`, destructure `broker` from options: `const { auth, access, broker } = options`. Then:

- After `const created = rows[0]` in the POST handler (before the idempotency store / `return`): `broker?.publish(name, 'create', created as Record<string, unknown>)`
- In PATCH, after `if (!rows[0]) {...}`: `broker?.publish(name, 'update', rows[0] as Record<string, unknown>)`
- In DELETE, before `return new Response(null, { status: 204 })`: `broker?.publish(name, 'delete', existing[0] as Record<string, unknown>)`

- [ ] **Step 4: Run tests**

Run: `bun test packages/bunderstack/src/crud-broadcast.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full core suite**

Run: `bun test packages/bunderstack`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/crud.ts packages/bunderstack/src/crud-broadcast.test.ts
git commit -m "feat(core): broadcast create/update/delete events from crud"
```

---

# Phase C — Realtime client in `bunderstack-query`

### Task C1: `createRealtimeClient`

**Files:**

- Create: `packages/bunderstack-query/src/realtime-client.ts`
- Modify: `packages/bunderstack-query/src/index.ts`
- Test: `packages/bunderstack-query/src/realtime-client.test.ts`

**Interfaces:**

- Consumes: `createTableClient(...).keys` (existing) for query-key factories; `@tanstack/query-core` `QueryClient`.
- Produces:
  - `createRealtimeClient(opts: { baseUrl: string; queryClient: QueryClient; tables: string[]; fetch?: typeof fetch; EventSourceImpl?: typeof EventSource }): { close(): void; subscribe(topics: string[]): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/bunderstack-query/src/realtime-client.test.ts
import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/query-core'
import { createRealtimeClient } from './realtime-client.ts'

// Minimal fake EventSource that lets the test push events.
class FakeES {
  static last: FakeES
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeES.last = this
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  close() {}
}

describe('createRealtimeClient', () => {
  it('on a create event, sets the detail cache and invalidates the list', async () => {
    const qc = new QueryClient()
    const fetchMock = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch
    const rt = createRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: qc,
      tables: ['cards'],
      fetch: fetchMock,
      EventSourceImpl: FakeES as unknown as typeof EventSource,
    })
    // connect event
    FakeES.last.emit({ clientId: 'c1' })
    await rt.subscribe(['cards'])
    FakeES.last.emit({
      action: 'create',
      table: 'cards',
      record: { id: 'card_1', title: 'A' },
    })

    expect(qc.getQueryData(['cards', 'detail', 'card_1'])).toEqual({
      id: 'card_1',
      title: 'A',
    })
    rt.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack-query/src/realtime-client.test.ts`
Expected: FAIL — module not found. (If `@tanstack/query-core` is not installed, add it: `bun add -D @tanstack/query-core --cwd packages/bunderstack-query`.)

- [ ] **Step 3: Implement the client**

```ts
// packages/bunderstack-query/src/realtime-client.ts
import type { QueryClient } from '@tanstack/query-core'

import { createTableClient } from './table-client.ts'

type RealtimeEvent = {
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}

export type RealtimeClientConfig = {
  baseUrl: string
  queryClient: QueryClient
  tables: string[]
  fetch?: typeof fetch
  EventSourceImpl?: typeof EventSource
}

export function createRealtimeClient(config: RealtimeClientConfig) {
  const { baseUrl, queryClient, tables } = config
  const fetchFn = config.fetch ?? fetch
  const ES = config.EventSourceImpl ?? EventSource
  const root = baseUrl.replace(/\/$/, '')

  // Per-table key factories (reuse the table-client's key scheme).
  const keysByTable = new Map(
    tables.map((t) => [
      t,
      createTableClient({ tableName: t, baseUrl: root, fetch: fetchFn }).keys,
    ]),
  )

  let clientId: string | null = null
  let lastTopics: string[] = []

  const es = new ES(`${root}/realtime`, { withCredentials: true })

  function apply(evt: RealtimeEvent) {
    const keys = keysByTable.get(evt.table)
    if (!keys) return
    const id = evt.record['id'] as string | number
    if (evt.action === 'delete') {
      queryClient.removeQueries({ queryKey: keys.detail(id) })
    } else {
      queryClient.setQueryData(keys.detail(id), evt.record)
    }
    queryClient.invalidateQueries({ queryKey: keys.lists() })
  }

  es.onmessage = (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { clientId?: string } | RealtimeEvent
    if ('clientId' in data && data.clientId) {
      clientId = data.clientId
      if (lastTopics.length) void postSubscribe(lastTopics)
      return
    }
    apply(data as RealtimeEvent)
  }

  async function postSubscribe(topics: string[]) {
    if (!clientId) return
    await fetchFn(`${root}/realtime`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, subscriptions: topics }),
    })
  }

  return {
    async subscribe(topics: string[]) {
      lastTopics = topics
      await postSubscribe(topics)
    },
    close() {
      es.close()
    },
  }
}
```

- [ ] **Step 4: Export from `index.ts`**

Add to `packages/bunderstack-query/src/index.ts`:

```ts
export { createRealtimeClient } from './realtime-client.ts'
export type { RealtimeClientConfig } from './realtime-client.ts'
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/bunderstack-query/src/realtime-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack-query/src/realtime-client.ts packages/bunderstack-query/src/index.ts packages/bunderstack-query/src/realtime-client.test.ts packages/bunderstack-query/package.json
git commit -m "feat(query): framework-agnostic realtime client wiring SSE into the query cache"
```

---

# Phase D — Example app (`examples/kanban`)

> The example phase is verified by **running** (not unit tests). Each task ends with a manual verification step and a commit. Keep components minimal.

### Task D1: Scaffold — schema, access, server, config, seed

**Files (create):**

- `examples/kanban/package.json`, `tsconfig.json`, `vite.config.ts`, `drizzle.config.ts`, `index.html`, `.env.example`
- `examples/kanban/src/schema.ts`, `src/access.ts`, `src/server.ts`, `scripts/seed.ts`

**Interfaces:**

- Produces: a working API on port 3004 with auto-CRUD + realtime for `boards/lists/cards/comments/activity`, scoped by org; BetterAuth with the `organization` plugin.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "bunderstack-example-kanban",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:api": "bun --hot src/server.ts",
    "dev:web": "vite",
    "db:push": "drizzle-kit push --config=drizzle.config.ts",
    "seed": "bun scripts/seed.ts"
  },
  "dependencies": {
    "bunderstack": "workspace:*",
    "bunderstack-query": "workspace:*",
    "better-auth": "^1.0.0",
    "@tanstack/solid-query": "^5.101.0",
    "@thisbeyond/solid-dnd": "^0.7.5",
    "@solidjs/router": "^0.15.0",
    "solid-js": "2.0.0-beta.0",
    "marked": "^14.0.0"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "vite-plugin-solid": "^2.11.0",
    "drizzle-kit": "^0.31.0"
  }
}
```

(Verify the exact published Solid 2 beta version with `bun info solid-js versions | tail` and use the latest `2.0.0-beta.*`; update `solid-js` and `vite-plugin-solid` accordingly.)

- [ ] **Step 2: `schema.ts`** — auth tables + org-plugin tables + app tables

```ts
// examples/kanban/src/schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { typeid } from 'bunderstack'

// --- BetterAuth core ---
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
})
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// --- BetterAuth organization plugin ---
export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
export const invitation = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

// --- App tables (typeid + denormalized organizationId) ---
export const boards = sqliteTable('boards', {
  id: typeid('board').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const lists = sqliteTable('lists', {
  id: typeid('list').primaryKey(),
  organizationId: text('organization_id').notNull(),
  boardId: text('board_id').notNull(),
  title: text('title').notNull(),
  position: real('position').notNull().default(1000),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const cards = sqliteTable('cards', {
  id: typeid('card').primaryKey(),
  organizationId: text('organization_id').notNull(),
  listId: text('list_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  assigneeId: text('assignee_id'),
  position: real('position').notNull().default(1000),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const comments = sqliteTable('comments', {
  id: typeid('cmt').primaryKey(),
  organizationId: text('organization_id').notNull(),
  cardId: text('card_id').notNull(),
  authorId: text('author_id'),
  body: text('body').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const activity = sqliteTable('activity', {
  id: typeid('act').primaryKey(),
  organizationId: text('organization_id').notNull(),
  boardId: text('board_id').notNull(),
  cardId: text('card_id'),
  actorId: text('actor_id'),
  type: text('type').notNull(),
  data: text('data', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
```

- [ ] **Step 3: `access.ts`** — org-scope every app table; hide auth/org tables

```ts
// examples/kanban/src/access.ts
import { defineAccess, type AccessContext } from 'bunderstack/access'
import * as schema from './schema'

const orgScope = (ctx: AccessContext) => ({
  organizationId: ctx.session?.activeOrganizationId ?? '__none__',
})

const orgTable = {
  list: 'authenticated',
  get: 'authenticated',
  create: 'authenticated',
  update: 'authenticated',
  delete: 'authenticated',
  scope: orgScope,
} as const

export const access = defineAccess(schema, {
  boards: {
    ...orgTable,
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  lists: {
    ...orgTable,
    filterableColumns: ['boardId'],
    sortableColumns: ['position', 'id'],
    defaultSort: { column: 'position', order: 'asc' },
  },
  cards: {
    ...orgTable,
    filterableColumns: ['listId', 'boardId'],
    sortableColumns: ['position', 'id'],
    defaultSort: { column: 'position', order: 'asc' },
  },
  comments: {
    ...orgTable,
    ownerColumn: 'authorId',
    filterableColumns: ['cardId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'asc' },
  },
  activity: {
    ...orgTable,
    create: 'authenticated',
    update: 'deny',
    delete: 'deny',
    ownerColumn: 'actorId',
    filterableColumns: ['boardId', 'cardId'],
    sortableColumns: ['createdAt', 'id'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  },
  // org-plugin + auth tables: managed by BetterAuth, not auto-CRUD
  user: { exposeAuthTable: true, list: 'authenticated', get: 'authenticated' },
  session: { crud: false },
  account: { crud: false },
  verification: { crud: false },
  organization: { crud: false },
  member: { crud: false },
  invitation: { crud: false },
})
```

(Note: `comments`/`activity` set `ownerColumn` so the author/actor is server-stamped from the session, while `scope` still constrains to the active org. The `'authenticated'` rule combined with `scope` means "logged in **and** in this org.")

- [ ] **Step 4: `server.ts`**

```ts
// examples/kanban/src/server.ts
import { createBunderstackAsync } from 'bunderstack'
import { organization } from 'better-auth/plugins'
import * as schema from './schema'
import { access } from './access'

const app = await createBunderstackAsync({
  schema,
  database: { url: 'file:./data.db' },
  auth: {
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  },
  access,
  realtime: true,
})

export const { db, auth } = app

const server = Bun.serve({ port: 3004, fetch: app.handler, idleTimeout: 0 })
console.log(`Kanban API on http://localhost:${server.port}`)
```

(`idleTimeout: 0` keeps SSE connections from being closed by Bun's default socket idle timeout.)

- [ ] **Step 5: `vite.config.ts`, `tsconfig.json`, `drizzle.config.ts`, `index.html`, `.env.example`**

```ts
// examples/kanban/vite.config.ts
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:3004' },
  },
})
```

```jsonc
// examples/kanban/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "types": ["bun-types", "vite/client"],
    "strict": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
  },
}
```

```ts
// examples/kanban/drizzle.config.ts
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './src/schema.ts',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'file:./data.db' },
})
```

```html
<!-- examples/kanban/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bunderstack Kanban</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/@knadh/oat/oat.min.css"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
```

```sh
# examples/kanban/.env.example
DATABASE_URL=file:./data.db
AUTH_SECRET=dev-secret-change-in-prod
```

- [ ] **Step 6: `scripts/seed.ts`**

```ts
// examples/kanban/scripts/seed.ts
import { auth, db } from '../src/server'
import * as schema from '../src/schema'

const users = [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Carol', email: 'carol@example.com' },
]

const created: { id: string }[] = []
for (const u of users) {
  const res = await auth.api.signUpEmail({
    body: { ...u, password: 'password123' },
  })
  created.push({ id: res.user.id })
}

// Create an org owned by Alice and add Bob + Carol as members.
const org = await auth.api.createOrganization({
  body: { name: 'Acme', slug: 'acme' },
  headers: new Headers(), // see note below
})
// NOTE: createOrganization needs Alice's session. During seed, call the
// internal adapter directly instead: insert organization + member rows via `db`.

const orgId = crypto.randomUUID()
await db
  .insert(schema.organization)
  .values({ id: orgId, name: 'Acme', slug: 'acme', createdAt: new Date() })
for (const u of created) {
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: u.id,
    role: u === created[0] ? 'owner' : 'member',
    createdAt: new Date(),
  })
}

const boardId = (
  await db
    .insert(schema.boards)
    .values({ organizationId: orgId, title: 'Roadmap' })
    .returning()
)[0].id
const listDefs = ['Backlog', 'In Progress', 'Done']
let pos = 1000
for (const title of listDefs) {
  const listId = (
    await db
      .insert(schema.lists)
      .values({ organizationId: orgId, boardId, title, position: pos })
      .returning()
  )[0].id
  await db.insert(schema.cards).values({
    organizationId: orgId,
    listId,
    title: `Sample card in ${title}`,
    position: 1000,
  })
  pos += 1000
}
console.log('Seeded org', orgId, 'board', boardId)
process.exit(0)
```

(Use the direct-insert path shown for org/member to avoid needing a live session in the seed. Remove the `auth.api.createOrganization` placeholder call — it is illustrative only.)

- [ ] **Step 7: Verify the API boots and is org-scoped**

```bash
cd examples/kanban && bun install
bun run dev:api   # starts on :3004
# in another shell:
bun run seed
curl -s http://localhost:3004/api/health   # -> {"status":"ok"}
```

Expected: health OK; seed prints an org + board id. (Unauthenticated `GET /api/boards` returns 401 — scope requires a session; that's correct.)

- [ ] **Step 8: Commit**

```bash
git add examples/kanban
git commit -m "feat(example): kanban scaffold — schema, org-scoped access, realtime API, seed"
```

---

### Task D2: Auth + query + realtime client wiring (web)

**Files (create):**

- `examples/kanban/src/lib/auth-client.ts`, `src/lib/query.ts`, `src/lib/oat.ts`
- `examples/kanban/src/index.tsx`, `src/app.tsx`, `src/routes/Login.tsx`

**Interfaces:**

- Produces: `authClient` (with org plugin), a configured solid `QueryClient` + `api` table clients + a connected `realtime` client, an app shell with routing + auth guard.

- [ ] **Step 1: `lib/auth-client.ts`**

```ts
// examples/kanban/src/lib/auth-client.ts
import { createAuthClient } from 'better-auth/solid'
import { organizationClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [organizationClient()],
})
```

- [ ] **Step 2: `lib/query.ts`** — solid-query client + table query options + realtime

```ts
// examples/kanban/src/lib/query.ts
import { QueryClient } from '@tanstack/solid-query'
import { createTableClient } from 'bunderstack-query'
import { createRealtimeClient } from 'bunderstack-query'

const baseUrl = '/api'
export const queryClient = new QueryClient()

const tables = ['boards', 'lists', 'cards', 'comments', 'activity'] as const
export type TableName = (typeof tables)[number]

export const tableClients = Object.fromEntries(
  tables.map((t) => [t, createTableClient({ tableName: t, baseUrl, fetch })]),
) as Record<TableName, ReturnType<typeof createTableClient>>

export const realtime = createRealtimeClient({
  baseUrl,
  queryClient,
  tables: [...tables],
})
```

- [ ] **Step 3: `lib/oat.ts`** — browser-only Oat toast loader (mirror the TanStack example)

```ts
// examples/kanban/src/lib/oat.ts
export function loadOat() {
  void import('@knadh/oat/oat.min.js')
}
export function toast(
  message: string,
  variant: 'success' | 'danger' | '' = '',
) {
  ;(
    window as unknown as {
      ot?: { toast: (m: string, t?: string, o?: object) => void }
    }
  ).ot?.toast(message, undefined, { variant })
}
```

(Add `"@knadh/oat": "^0.x"` to `package.json` dependencies — check the version with `bun info @knadh/oat version`.)

- [ ] **Step 4: `routes/Login.tsx`** — sign in / sign up

```tsx
// examples/kanban/src/routes/Login.tsx
import { createSignal } from 'solid-js'
import { authClient } from '../lib/auth-client'
import { toast } from '../lib/oat'

export function Login() {
  const [mode, setMode] = createSignal<'in' | 'up'>('in')
  const [email, setEmail] = createSignal('alice@example.com')
  const [password, setPassword] = createSignal('password123')
  const [name, setName] = createSignal('Alice')

  async function submit(e: Event) {
    e.preventDefault()
    const fn =
      mode() === 'in'
        ? authClient.signIn.email({ email: email(), password: password() })
        : authClient.signUp.email({
            email: email(),
            password: password(),
            name: name(),
          })
    const { error } = await fn
    if (error) toast(error.message ?? 'Auth failed', 'danger')
    else window.location.href = '/'
  }

  return (
    <main class="ot-container" style="max-width: 24rem; margin: 4rem auto">
      <h1>Kanban</h1>
      <form onSubmit={submit}>
        {mode() === 'up' && (
          <input
            placeholder="Name"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        )}
        <input
          placeholder="Email"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
        <input
          type="password"
          placeholder="Password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        <button type="submit">{mode() === 'in' ? 'Sign in' : 'Sign up'}</button>
      </form>
      <button
        class="ot-btn-link"
        onClick={() => setMode(mode() === 'in' ? 'up' : 'in')}
      >
        {mode() === 'in' ? 'Need an account?' : 'Have an account?'}
      </button>
    </main>
  )
}
```

- [ ] **Step 5: `app.tsx` + `index.tsx`** — providers, router, auth guard, active org

```tsx
// examples/kanban/src/app.tsx
import { Show, Suspense } from 'solid-js'
import { Router, Route, Navigate } from '@solidjs/router'
import { QueryClientProvider } from '@tanstack/solid-query'
import { queryClient } from './lib/query'
import { authClient } from './lib/auth-client'
import { Login } from './routes/Login'
import { Boards } from './routes/Boards'
import { Board } from './routes/Board'

function Protected(props: { children: any }) {
  const session = authClient.useSession()
  return (
    <Suspense fallback={<p class="ot-container">Loading…</p>}>
      <Show when={session().data} fallback={<Navigate href="/login" />}>
        {props.children}
      </Show>
    </Suspense>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Route path="/login" component={Login} />
        <Route
          path="/"
          component={() => (
            <Protected>
              <Boards />
            </Protected>
          )}
        />
        <Route
          path="/boards/:id"
          component={() => (
            <Protected>
              <Board />
            </Protected>
          )}
        />
      </Router>
    </QueryClientProvider>
  )
}
```

```tsx
// examples/kanban/src/index.tsx
import { render } from 'solid-js/web'
import { App } from './app'
import { loadOat } from './lib/oat'

loadOat()
render(() => <App />, document.getElementById('root')!)
```

(Verify Solid 2 `render`/`Suspense`/control-flow imports against the migration guide; adjust if the beta moved any export.)

- [ ] **Step 6: Verify login works end-to-end**

```bash
# terminal 1: cd examples/kanban && bun run dev:api
# terminal 2: cd examples/kanban && bun run dev:web
# browse http://localhost:5174/login, sign in as alice@example.com / password123
```

Expected: redirect to `/` (Boards route — will render once D3 lands; for now an empty/placeholder is fine if Boards is stubbed). Network tab shows `/api/auth/*` 200s.

- [ ] **Step 7: Commit**

```bash
git add examples/kanban/src examples/kanban/package.json
git commit -m "feat(example): web auth, solid-query + realtime client, app shell"
```

---

### Task D3: Boards list + active-org selection

**Files (create):** `examples/kanban/src/routes/Boards.tsx`

**Interfaces:**

- Consumes: `tableClients.boards`, `authClient` org APIs, `realtime`.
- Produces: list of boards in the active org with create; sets active org on mount.

- [ ] **Step 1: Implement `Boards.tsx`**

```tsx
// examples/kanban/src/routes/Boards.tsx
import { createSignal, For, onMount } from 'solid-js'
import { A } from '@solidjs/router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/solid-query'
import { tableClients, realtime } from '../lib/query'
import { authClient } from '../lib/auth-client'

const boardsClient = tableClients.boards

export function Boards() {
  const qc = useQueryClient()
  const [title, setTitle] = createSignal('')

  onMount(async () => {
    // Pick the user's first org as active, then subscribe to board changes.
    const orgs = await authClient.organization.list()
    const first = orgs.data?.[0]
    if (first)
      await authClient.organization.setActive({ organizationId: first.id })
    await realtime.subscribe(['boards'])
    qc.invalidateQueries({ queryKey: boardsClient.keys.lists() })
  })

  const boards = useQuery(() => ({
    ...boardsClient.listQuery({ limit: 50 }),
    queryFn: () => boardsClient.list({ limit: 50 }),
  }))

  const create = useMutation(() => ({
    mutationFn: () => boardsClient.create({ title: title() }),
    onSuccess: () => {
      setTitle('')
      qc.invalidateQueries({ queryKey: boardsClient.keys.lists() })
    },
  }))

  return (
    <main class="ot-container" style="max-width: 40rem; margin: 2rem auto">
      <header style="display:flex; justify-content:space-between; align-items:center">
        <h1>Boards</h1>
        <button
          onClick={() =>
            authClient.signOut().then(() => (window.location.href = '/login'))
          }
        >
          Sign out
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
        style="display:flex; gap:.5rem"
      >
        <input
          placeholder="New board title"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <button type="submit" disabled={!title()}>
          Create
        </button>
      </form>
      <ul>
        <For each={boards.data?.items ?? []}>
          {(b) => (
            <li>
              <A href={`/boards/${b.id}`}>{b.title}</A>
            </li>
          )}
        </For>
      </ul>
    </main>
  )
}
```

(`useQuery` takes the table client's `listQuery` options; `queryFn` is set explicitly to call `boardsClient.list` because the core client's option object is framework-neutral. Verify the `listQuery` shape from `table-client.ts` and simplify if it already supplies a `queryFn`.)

- [ ] **Step 2: Verify**

Reload `/`. Expected: shows seeded "Roadmap" board; creating a board adds it to the list. Open a second browser/incognito signed in as Bob → creating a board in one tab appears in the other within ~instant (realtime), no manual refresh.

- [ ] **Step 3: Commit**

```bash
git add examples/kanban/src/routes/Boards.tsx
git commit -m "feat(example): boards list, create, active-org selection, realtime"
```

---

### Task D4: Board view — lists, cards, drag-and-drop, realtime

**Files (create):** `examples/kanban/src/routes/Board.tsx`, `src/components/ListColumn.tsx`, `src/components/CardItem.tsx`

**Interfaces:**

- Consumes: `tableClients.{lists,cards,activity}`, `realtime`, `@thisbeyond/solid-dnd`.
- Produces: a board page that subscribes to `lists`, `cards`, `comments`, `activity`; renders columns + cards; drag a card across/within lists → PATCH `listId` + `position` (midpoint) + write an `activity` row.

- [ ] **Step 1: Implement `Board.tsx`** (data + subscriptions + DnD container)

```tsx
// examples/kanban/src/routes/Board.tsx
import { onMount, For, createMemo } from 'solid-js'
import { useParams } from '@solidjs/router'
import { useQuery, useQueryClient } from '@tanstack/solid-query'
import {
  DragDropProvider,
  DragDropSensors,
  closestCenter,
} from '@thisbeyond/solid-dnd'
import { tableClients, realtime } from '../lib/query'
import { ListColumn } from '../components/ListColumn'

const { lists: listsC, cards: cardsC, activity: activityC } = tableClients

export function Board() {
  const params = useParams()
  const qc = useQueryClient()
  const boardId = () => params.id

  onMount(async () => {
    await realtime.subscribe(['lists', 'cards', 'comments', 'activity'])
  })

  const lists = useQuery(() => ({
    queryKey: listsC.keys.list({ boardId: boardId() }),
    queryFn: () => listsC.list({ boardId: boardId(), limit: 100 }),
  }))
  const cards = useQuery(() => ({
    queryKey: cardsC.keys.list({ boardId: boardId() }),
    queryFn: () => cardsC.list({ boardId: boardId(), limit: 500 }),
  }))

  const cardsByList = createMemo(() => {
    const map = new Map<string, any[]>()
    for (const c of cards.data?.items ?? []) {
      const arr = map.get(c.listId) ?? []
      arr.push(c)
      map.set(c.listId, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position)
    return map
  })

  async function onDragEnd({ draggable, droppable }: any) {
    if (!draggable || !droppable) return
    const cardId = String(draggable.id)
    const targetListId = String(droppable.id)
    const siblings = (cardsByList().get(targetListId) ?? []).filter(
      (c) => c.id !== cardId,
    )
    const newPos = (siblings.at(-1)?.position ?? 0) + 1000 // append to end (simple, minimal)
    await cardsC.update(cardId, { listId: targetListId, position: newPos })
    await activityC.create({
      boardId: boardId(),
      cardId,
      type: 'moved',
      data: { listId: targetListId },
    })
    qc.invalidateQueries({ queryKey: cardsC.keys.list({ boardId: boardId() }) })
  }

  return (
    <main style="padding: 1rem">
      <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <div style="display:flex; gap:1rem; align-items:flex-start; overflow-x:auto">
          <For each={lists.data?.items ?? []}>
            {(list) => (
              <ListColumn
                list={list}
                cards={cardsByList().get(list.id) ?? []}
                boardId={boardId()}
              />
            )}
          </For>
        </div>
      </DragDropProvider>
    </main>
  )
}
```

(Drop targets are lists; on drop a card appends to the target list's end. This keeps ordering minimal — between-card insertion via fractional midpoint is a stretch goal noted in the README. Verify `@thisbeyond/solid-dnd` event prop names against its docs; the package exposes `createDroppable`/`createDraggable` directives used in the components below.)

- [ ] **Step 2: Implement `ListColumn.tsx`** (droppable + add card)

```tsx
// examples/kanban/src/components/ListColumn.tsx
import { For, createSignal } from 'solid-js'
import { createDroppable } from '@thisbeyond/solid-dnd'
import { useQueryClient } from '@tanstack/solid-query'
import { tableClients } from '../lib/query'
import { CardItem } from './CardItem'

export function ListColumn(props: {
  list: any
  cards: any[]
  boardId: string
}) {
  const droppable = createDroppable(props.list.id)
  const qc = useQueryClient()
  const [title, setTitle] = createSignal('')
  const cardsC = tableClients.cards

  async function addCard(e: Event) {
    e.preventDefault()
    const pos = (props.cards.at(-1)?.position ?? 0) + 1000
    await cardsC.create({
      listId: props.list.id,
      boardId: props.boardId,
      title: title(),
      position: pos,
    })
    setTitle('')
    qc.invalidateQueries({
      queryKey: cardsC.keys.list({ boardId: props.boardId }),
    })
  }

  return (
    <div
      use:droppable
      class="ot-card"
      style="min-width:16rem; padding:.75rem; background:#f4f4f5"
    >
      <strong>{props.list.title}</strong>
      <div style="display:flex; flex-direction:column; gap:.5rem; margin:.5rem 0">
        <For each={props.cards}>{(card) => <CardItem card={card} />}</For>
      </div>
      <form onSubmit={addCard}>
        <input
          placeholder="+ Add card"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </form>
    </div>
  )
}
```

- [ ] **Step 3: Implement `CardItem.tsx`** (draggable + open dialog)

```tsx
// examples/kanban/src/components/CardItem.tsx
import { createDraggable } from '@thisbeyond/solid-dnd'
import { openCard } from './CardDialog'

export function CardItem(props: { card: any }) {
  const draggable = createDraggable(props.card.id)
  return (
    <div
      use:draggable
      class="ot-card"
      style="padding:.5rem; cursor:grab; background:white"
      onClick={() => openCard(props.card.id)}
    >
      {props.card.title}
    </div>
  )
}
```

(`CardDialog`/`openCard` are added in D5; for D4, stub `export function openCard(_id: string) {}` in `CardDialog.tsx` so this compiles, then flesh it out in D5.)

- [ ] **Step 4: Verify**

Open a board in two tabs (Alice + Bob). Expected: adding a card in one appears in the other live; dragging a card to another column persists (PATCH 200) and reflects in both tabs; an `activity` row is created (`GET /api/activity?boardId=…` shows a `moved` entry).

- [ ] **Step 5: Commit**

```bash
git add examples/kanban/src/routes/Board.tsx examples/kanban/src/components/ListColumn.tsx examples/kanban/src/components/CardItem.tsx
git commit -m "feat(example): board view with lists, cards, drag-and-drop, realtime"
```

---

### Task D5: Card dialog — markdown description, assignee, comments, activity

**Files (create):** `examples/kanban/src/components/CardDialog.tsx`

**Interfaces:**

- Consumes: `tableClients.{cards,comments,activity,...}`, `authClient` (members for assignee), `marked`.
- Produces: a modal showing one card: editable markdown description (textarea + rendered preview), assignee picker over org members, comment thread, activity feed. `openCard(id)` opens it.

- [ ] **Step 1: Implement `CardDialog.tsx`**

```tsx
// examples/kanban/src/components/CardDialog.tsx
import { createSignal, Show, For, createResource } from 'solid-js'
import { marked } from 'marked'
import { useQueryClient } from '@tanstack/solid-query'
import { tableClients } from '../lib/query'
import { authClient } from '../lib/auth-client'

const [cardId, setCardId] = createSignal<string | null>(null)
export function openCard(id: string) {
  setCardId(id)
}

const { cards: cardsC, comments: commentsC, activity: activityC } = tableClients

export function CardDialog() {
  const qc = useQueryClient()
  const [card] = createResource(cardId, (id) => cardsC.get(id))
  const [members] = createResource(
    async () => (await authClient.organization.listMembers?.())?.data ?? [],
  )
  const [commentBody, setCommentBody] = createSignal('')
  const [desc, setDesc] = createSignal('')

  const commentsRes = () => commentsC.list({ cardId: cardId()!, limit: 100 })
  const [commentList, { refetch }] = createResource(cardId, () => commentsRes())

  async function saveDesc() {
    await cardsC.update(cardId()!, { description: desc() })
    qc.invalidateQueries({ queryKey: cardsC.keys.detail(cardId()!) })
  }
  async function assign(userId: string) {
    await cardsC.update(cardId()!, { assigneeId: userId })
    qc.invalidateQueries({ queryKey: cardsC.keys.detail(cardId()!) })
  }
  async function addComment(e: Event) {
    e.preventDefault()
    await commentsC.create({ cardId: cardId()!, body: commentBody() })
    await activityC.create({
      boardId: card()?.boardId,
      cardId: cardId()!,
      type: 'commented',
    })
    setCommentBody('')
    refetch()
  }

  return (
    <Show when={cardId()}>
      <dialog open class="ot-modal" style="max-width:36rem">
        <Show when={card()}>
          <header style="display:flex; justify-content:space-between">
            <h2>{card()!.title}</h2>
            <button onClick={() => setCardId(null)}>✕</button>
          </header>

          <label>Assignee</label>
          <select
            value={card()!.assigneeId ?? ''}
            onChange={(e) => assign(e.currentTarget.value)}
          >
            <option value="">Unassigned</option>
            <For each={members() ?? []}>
              {(m: any) => (
                <option value={m.userId}>{m.user?.name ?? m.userId}</option>
              )}
            </For>
          </select>

          <label>Description (markdown)</label>
          <textarea rows="5" onInput={(e) => setDesc(e.currentTarget.value)}>
            {card()!.description ?? ''}
          </textarea>
          <button onClick={saveDesc}>Save</button>
          <div innerHTML={marked.parse(card()!.description ?? '') as string} />

          <h3>Comments</h3>
          <For each={commentList()?.items ?? []}>
            {(c: any) => (
              <p>
                <strong>{c.authorId}</strong>: {c.body}
              </p>
            )}
          </For>
          <form onSubmit={addComment}>
            <input
              placeholder="Add a comment"
              value={commentBody()}
              onInput={(e) => setCommentBody(e.currentTarget.value)}
            />
          </form>
        </Show>
      </dialog>
    </Show>
  )
}
```

Mount `<CardDialog />` once in `Board.tsx` (add `import { CardDialog } from '../components/CardDialog'` and render it at the end of the `<main>`). Replace the D4 stub `openCard` import in `CardItem.tsx` — it now resolves to the real one.

(Verify `authClient.organization.listMembers` exists in the installed BetterAuth org client; if the method name differs, fetch members via `tableClients` is not possible — `member` is `crud:false` — so use the org client's members API. Check `authClient.organization` keys at runtime and adjust.)

- [ ] **Step 2: Verify**

Click a card → dialog opens. Edit description, Save → preview renders markdown; reopening shows it persisted. Assign a member → persists. Add a comment → appears; a second tab viewing the same card sees the new comment live (comments subscription). Activity feed gains a `commented` entry.

- [ ] **Step 3: Commit**

```bash
git add examples/kanban/src/components/CardDialog.tsx examples/kanban/src/routes/Board.tsx examples/kanban/src/components/CardItem.tsx
git commit -m "feat(example): card dialog — markdown description, assignee, comments, activity"
```

---

### Task D6: Docs

**Files:**

- Create: `examples/kanban/README.md`
- Modify: `examples/README.md`

- [ ] **Step 1: Write `examples/kanban/README.md`**

Document: what it shows (typeid, org-scoped access, realtime), prerequisites, the two-process dev flow (`dev:api` on 3004 + `dev:web` on 5174 with Vite proxy), `db:push`, `seed`, demo accounts (`alice/bob/carol@example.com` / `password123`), the route table, and the realtime model (SSE `GET/POST /api/realtime`, broadcast-on-write, scope-authorized). Note stretch goals left out: fractional between-card ordering, invitations UI.

- [ ] **Step 2: Add a "Kanban" section to `examples/README.md`**

Add a row to the run table (`dev:kanban` → http://localhost:5174) and a short section mirroring the TanStack entry: realtime kanban — orgs/boards/lists/cards/comments/activity, Solid 2 + Oat, realtime via SSE. Add root `package.json` script `"dev:kanban": "bun run --cwd examples/kanban dev:api"` (web runs via Vite separately) — or document both commands explicitly.

- [ ] **Step 3: Commit**

```bash
git add examples/kanban/README.md examples/README.md package.json
git commit -m "docs(example): kanban README and examples index entry"
```

---

## Self-Review

**Spec coverage:**

- Part 1 (access scope) → Tasks A1–A4. ✓ (equality map, in-memory + SQL, session.activeOrganizationId, create-stamping).
- Part 2 (realtime SSE, broker, broadcast-on-write, per-event get-rule + scope auth, clientId/POST handshake, in-memory, no replay) → Tasks B1–B3. ✓
- Part 3 (bunderstack-query realtime client) → Task C1. ✓
- Part 4 (kanban: data model w/ typeid + denormalized orgId, org-scope access, drag-drop fractional-ish ordering, markdown desc, comments, activity, Vite+proxy topology, seed, routes) → Tasks D1–D6. ✓
- BetterAuth org plugin for orgs/members/invitations → D1 (server plugin), D2 (client plugin), D3/D5 (org APIs). ✓ (Invitation **UI** intentionally deferred — README notes it; org plugin endpoints exist.)

**Placeholder scan:** No "TBD"/"add error handling" left. Two spots flagged as _verify-against-docs_ (Solid 2 beta exports; exact `@thisbeyond/solid-dnd` event prop + `authClient.organization` member method) are explicit verification steps with concrete fallback code, not placeholders. The seed's `createOrganization` illustration is explicitly replaced by the direct-insert path.

**Type consistency:**

- Event payload `{ action, table, record }` consistent across B1 (broker), B2 (SSE test), B3 (broadcast), C1 (client). ✓
- `resolveSession` return `{ user, activeOrganizationId }` consistent A1 → A4 → B2. ✓
- `AccessContext.session.activeOrganizationId` consistent A1 → access.ts scope resolvers → broker. ✓
- `RealtimeBroker` surface (`register/setContext/unregister/publish`) consistent B1 → B2 → B3. ✓
- `scope` resolver shape `(ctx) => Record<string, string|string[]>` consistent A1 → example access.ts. ✓

**Note for executor:** `checkAccessSync` is introduced in B1 specifically so realtime delivery stays synchronous/cheap; function `get`-rules are unsupported on realtime v1 (the example uses enum `get` + scope, so this is fine).
