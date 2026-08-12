# API Declaration Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an application declare its oRPC procedures in plain modules with plain imports, and let one middleware list cover every procedure in the graph.

**Architecture:** `defineApi(values)` returns the oRPC builder at module scope, so router files stop being factories. The `api` option accepts the finished router object. A new `middleware` option reaches every procedure through the oRPC builder method `.router()`. Three small additions support this: `context.peekSession()`, public database types, and a `listProcedure` helper built on the existing list-query code.

**Tech Stack:** Bun, TypeScript, oRPC v2 (`@orpc/server@2.0.0-beta.26`), Drizzle, Valibot, `bun:test`.

## Global Constraints

- The design document is `docs/superpowers/specs/2026-08-12-api-declaration-design.md`. Read it before Task 1.
- Repository for Tasks 1–9: `/Users/kirill/Projects/bunderstack-project/bunderstack/.worktrees/orpc-api-spike`.
- Repository for Tasks 10–14: `/Users/kirill/Projects/bunderstack-project/hrbreakers.com-bunderstack`.
- Use Bun for every command. Use `bun test`, not vitest or jest.
- Do not add a runtime dependency on Hono, tRPC, Zod, or drizzle-zod.
- The `api` callback form must keep working. This plan adds a form; it removes none.
- oRPC packages stay pinned at the versions already in `bun.lock`. Do not upgrade them.
- Do not delete the role middleware in the application until Task 12 proves the behavior with a passing test.
- Every task ends with a commit.

---

## File Structure

**Framework — create:**

| File | Responsibility |
| --- | --- |
| `packages/bunderstack/src/api/define-api.test.ts` | Tests for `defineApi`. |
| `packages/bunderstack/src/api/global-middleware.test.ts` | Tests that a configured middleware reaches every procedure family. |
| `packages/bunderstack/src/api/list-input-schema.ts` | Builds the list input schema for a table. Shared by the CRUD router and `listProcedure`. |
| `packages/bunderstack/src/api/list-procedure.ts` | The `listProcedure` helper. |
| `packages/bunderstack/src/api/list-procedure.test.ts` | Tests for `listProcedure`. |
| `packages/bunderstack/src/db-types.test.ts` | Type test for `BunderstackDb` and `BunderstackTx`. |

**Framework — modify:**

| File | Change |
| --- | --- |
| `packages/bunderstack/src/api/builder.ts` | Add `defineApi`. |
| `packages/bunderstack/src/api/context.ts` | Add `peekSession()`. |
| `packages/bunderstack/src/api/context.test.ts` | Add `peekSession()` tests. |
| `packages/bunderstack/src/api/router.ts` | `buildApiRouter` applies the middleware list. |
| `packages/bunderstack/src/api/crud-router.ts` | Use the extracted list input schema builder. |
| `packages/bunderstack/src/config.ts` | `api` accepts an object. Add `middleware`. |
| `packages/bunderstack/src/db.ts` | Add `BunderstackDb` and `BunderstackTx`. |
| `packages/bunderstack/src/index.ts` | Resolve the `api` option. Pass the middleware. Add exports. |

**Application — create:**

| File | Responsibility |
| --- | --- |
| `src/bunderstack/api/base.ts` | The builder, the three base procedures, and the instrumentation middleware. |

**Application — modify:** `src/bunderstack/api/index.ts`, `public.ts`, `telegram.ts`, `adaptation.ts`, `credit.ts`, `admin.ts`, `src/bunderstack/index.ts`, and the admin client code that reads list responses.

---

## Task 1: `defineApi`

**Files:**
- Modify: `packages/bunderstack/src/api/builder.ts`
- Modify: `packages/bunderstack/src/index.ts` (export block near line 822)
- Test: `packages/bunderstack/src/api/define-api.test.ts`

**Interfaces:**
- Consumes: `createApiBuilder<TSchema, TEnv>()` from `./builder`, `ValidatedEnv` and `EnvConfigInput` from `../env`.
- Produces: `defineApi<TSchema, TEnv>(options: { schema: TSchema; env?: TEnv }): BunderstackApiBuilder<TSchema, ValidatedEnv<TEnv>>`.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack/src/api/define-api.test.ts`:

```ts
import { createProcedureClient } from '@orpc/server'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { createApiContext } from './context'
import { defineApi } from './builder'

const todos = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const schema = { todos }
const envSchema = { server: { STRIPE_KEY: v.string() } }

function createTestDeps() {
  return {
    db: { fakeDb: true } as any,
    env: { STRIPE_KEY: 'sk_test', DATABASE_URL: 'file:./x.db' } as any,
    storage: { fakeStorage: true } as any,
    email: { fakeEmail: true } as any,
    jobs: { fakeJobs: true } as any,
    realtime: { fakeRealtime: true } as any,
    auth: { fakeAuth: true } as any,
    authResolver: undefined,
  }
}

test('defineApi returns the same bases as createApiBuilder', async () => {
  const o = defineApi({ schema, env: envSchema })

  expect(typeof o.public).toBe('object')
  expect(typeof o.protected).toBe('object')
  expect(typeof o.webhook).toBe('object')
})

test('defineApi infers env and schema types from the values it receives', async () => {
  const o = defineApi({ schema, env: envSchema })

  const procedure = o.public.handler(({ context }) => {
    // Compiles only when TEnv is inferred from `envSchema`.
    const key: string = context.env.STRIPE_KEY
    return { key, hasDb: !!context.db }
  })

  const client = createProcedureClient(procedure, {
    context: createApiContext(createTestDeps(), new Request('http://localhost/api/t')),
  })

  expect(await client(undefined)).toEqual({ key: 'sk_test', hasDb: true })
})

test('defineApi works without an env schema', async () => {
  const o = defineApi({ schema })

  const procedure = o.public.handler(({ context }) => {
    // Compiles only when TEnv falls back to BaseEnv.
    const url: string = context.env.DATABASE_URL
    return { url }
  })

  const client = createProcedureClient(procedure, {
    context: createApiContext(createTestDeps(), new Request('http://localhost/api/t')),
  })

  expect(await client(undefined)).toEqual({ url: 'file:./x.db' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/bunderstack/src/api/define-api.test.ts`
Expected: FAIL. The message names `defineApi` as an undefined export.

- [ ] **Step 3: Write the implementation**

Append to `packages/bunderstack/src/api/builder.ts`:

```ts
import type { EnvConfigInput, ValidatedEnv } from '../env'

/**
 * Same builder as `createApiBuilder`, but the generics come from the values an
 * application already has. It reads nothing at runtime, so a module can call it
 * at import time and export the bases that its router modules import.
 */
export function defineApi<
  TSchema extends Record<string, unknown>,
  TEnv extends EnvConfigInput | undefined = undefined,
>(_options: { schema: TSchema; env?: TEnv }) {
  return createApiBuilder<TSchema, ValidatedEnv<TEnv>>()
}
```

- [ ] **Step 4: Add the public export**

In `packages/bunderstack/src/index.ts`, change the line that reads
`export { createApiBuilder } from './api/builder'` to:

```ts
export { createApiBuilder, defineApi } from './api/builder'
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `bun test packages/bunderstack/src/api/define-api.test.ts`
Expected: PASS, 3 tests.

Run: `bun run typecheck`
Expected: no output and exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/api/builder.ts packages/bunderstack/src/api/define-api.test.ts packages/bunderstack/src/index.ts
git commit -m "feat(api): add defineApi for module-scope builders"
```

---

## Task 2: the `api` option accepts a router object

**Files:**
- Modify: `packages/bunderstack/src/config.ts:171`
- Modify: `packages/bunderstack/src/index.ts:511`
- Test: `packages/bunderstack/src/api/router.test.ts`

**Interfaces:**
- Consumes: `BunderstackApiBuilder` from `./api/builder`.
- Produces: the `api` option type
  `TCustomApiRouter | ((builder: BunderstackApiBuilder<TSchema, ValidatedEnv<TEnv>>) => TCustomApiRouter)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/api/router.test.ts`:

```ts
test('createBunderstack accepts a router object for the api option', async () => {
  const o = defineApi({ schema: testSchema })
  const api = {
    ping: o.public.handler(() => ({ pong: true })),
  }

  const app = await createBunderstack({
    schema: testSchema,
    database: { adapter: libsql(), url: ':memory:' },
    api,
  })

  const response = await app.handler(
    new Request('http://localhost/api/rpc/ping', { method: 'POST', body: '{}' }),
  )

  expect(response.status).toBe(200)
})
```

Add the imports this test needs at the top of the file:

```ts
import { createBunderstack } from '../index'
import { libsql } from '../database/libsql'
import { defineApi } from './builder'
```

If `testSchema` does not already exist in this file, add it above the test:

```ts
const testSchema = {
  notes: sqliteTable('notes', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
  }),
}
```

with `import { sqliteTable, text } from 'drizzle-orm/sqlite-core'`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/bunderstack/src/api/router.test.ts`
Expected: FAIL. `options.api` is called as a function, so the run throws
`options.api is not a function`.

- [ ] **Step 3: Widen the option type**

In `packages/bunderstack/src/config.ts`, replace the `api` field:

```ts
  /**
   * The application's oRPC router. Pass the finished router object, or a
   * callback when the router needs the framework builder at configuration
   * time.
   */
  api?:
    | TCustomApiRouter
    | ((
        builder: BunderstackApiBuilder<TSchema, ValidatedEnv<TEnv>>,
      ) => TCustomApiRouter)
```

- [ ] **Step 4: Resolve both forms**

In `packages/bunderstack/src/index.ts`, replace the `customApiRouter` block:

```ts
    const customApiRouter =
      typeof options.api === 'function'
        ? (options.api as (
            builder: BunderstackApiBuilder<TSchema, ValidatedEnv<TEnv>>,
          ) => TCustomApiRouter)(createApiBuilder<TSchema, ValidatedEnv<TEnv>>())
        : options.api
```

Add `import type { BunderstackApiBuilder } from './api/builder'` if the file
does not already import it.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/bunderstack/src/api/router.test.ts`
Expected: PASS, including the existing callback tests.

Run: `bun run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/api/router.test.ts
git commit -m "feat(api): accept a router object for the api option"
```

---

## Task 3: `context.peekSession()`

**Files:**
- Modify: `packages/bunderstack/src/api/context.ts`
- Test: `packages/bunderstack/src/api/context.test.ts`

**Interfaces:**
- Produces: `ApiContext.peekSession(): { user: AccessUser | null; activeOrganizationId: string | null } | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/api/context.test.ts`:

```ts
test('peekSession returns undefined and starts no resolution before getSession runs', () => {
  const getSession = mock(async () => ({
    user: { id: 'usr_1', email: 'user@example.com' },
    session: { activeOrganizationId: 'org_1' },
  }))
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  expect(context.peekSession()).toBeUndefined()
  expect(getSession).toHaveBeenCalledTimes(0)
})

test('peekSession returns the resolved session after getSession settles', async () => {
  const getSession = mock(async () => ({
    user: { id: 'usr_1', email: 'user@example.com' },
    session: { activeOrganizationId: 'org_1' },
  }))
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  await context.getSession()

  expect(context.peekSession()).toEqual({
    user: { id: 'usr_1', email: 'user@example.com', name: undefined, role: undefined },
    activeOrganizationId: 'org_1',
  })
  expect(getSession).toHaveBeenCalledTimes(1)
})

test('peekSession returns undefined while getSession is still pending', async () => {
  let release: (value: unknown) => void = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const getSession = mock(async () => {
    await gate
    return {
      user: { id: 'usr_1', email: 'user@example.com' },
      session: { activeOrganizationId: null },
    }
  })
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  const pending = context.getSession()
  expect(context.peekSession()).toBeUndefined()

  release(undefined)
  await pending
  expect(context.peekSession()?.user?.id).toBe('usr_1')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/bunderstack/src/api/context.test.ts`
Expected: FAIL. `context.peekSession is not a function`.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/api/context.ts`, add the field to the interface:

```ts
  /**
   * The session that some earlier code already resolved, or `undefined`.
   * Never starts a resolution, so a global middleware can log the caller
   * without removing the lazy session behavior that signed webhooks rely on.
   * Use it for observability only. Never use it for authorization.
   */
  peekSession: () =>
    | { user: AccessUser | null; activeOrganizationId: string | null }
    | undefined
```

In `createApiContext`, record the settled value and return it:

```ts
  let settledSession:
    | { user: AccessUser | null; activeOrganizationId: string | null }
    | undefined

  const getSession = () => {
    if (!sessionPromise) {
      sessionPromise = resolveSession(deps.authResolver, request.headers).then(
        (session) => {
          settledSession = session
          return session
        },
      )
    }
    return sessionPromise
  }

  const peekSession = () => settledSession
```

Add `peekSession` to the returned object, next to `getSession`.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/bunderstack/src/api/context.test.ts`
Expected: PASS, including the existing memoization tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/api/context.ts packages/bunderstack/src/api/context.test.ts
git commit -m "feat(api): add context.peekSession for observability"
```

---

## Task 4: the `middleware` option

**Files:**
- Modify: `packages/bunderstack/src/api/router.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/index.ts:514`
- Test: `packages/bunderstack/src/api/global-middleware.test.ts`

**Interfaces:**
- Consumes: `AnyMiddleware` from `@orpc/server`; `createApiBuilder` from `./builder`.
- Produces: `BuildApiRouterOptions.middleware?: AnyMiddleware[]`; the config field
  `middleware?: AnyMiddleware[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack/src/api/global-middleware.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { defineApi } from './builder'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
})

const schema = { notes }

async function createApp(paths: string[][]) {
  const o = defineApi({ schema })

  const record = o.middleware(async ({ path, next }) => {
    paths.push(path)
    return next()
  })

  return createBunderstack({
    schema,
    database: { adapter: libsql(), url: ':memory:' },
    middleware: [record],
    api: {
      ping: o.public.handler(() => ({ pong: true })),
    },
  })
}

test('a configured middleware runs for a custom procedure', async () => {
  const paths: string[][] = []
  const app = await createApp(paths)

  await app.handler(
    new Request('http://localhost/api/rpc/ping', { method: 'POST', body: '{}' }),
  )

  expect(paths).toContainEqual(['ping'])
})

test('a configured middleware runs for a generated CRUD procedure', async () => {
  const paths: string[][] = []
  const app = await createApp(paths)

  await app.handler(new Request('http://localhost/api/notes'))

  expect(paths).toContainEqual(['notes', 'list'])
})

test('a configured middleware runs for the health procedure', async () => {
  const paths: string[][] = []
  const app = await createApp(paths)

  await app.handler(new Request('http://localhost/api/health'))

  expect(paths).toContainEqual(['health'])
})

test('a configured middleware does not resolve the session', async () => {
  const seen: (string | undefined)[] = []
  const o = defineApi({ schema })

  const record = o.middleware(async ({ context, next }) => {
    const result = await next()
    seen.push(context.peekSession()?.user?.id ?? 'unresolved')
    return result
  })

  const app = await createBunderstack({
    schema,
    database: { adapter: libsql(), url: ':memory:' },
    middleware: [record],
    api: {
      hook: o.webhook
        .route({ method: 'POST', path: '/webhooks/demo' })
        .handler(async ({ context }) => ({ body: await context.getRawBody() })),
    },
  })

  await app.handler(
    new Request('http://localhost/webhooks/demo', { method: 'POST', body: '{}' }),
  )

  expect(seen).toEqual(['unresolved'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/bunderstack/src/api/global-middleware.test.ts`
Expected: FAIL. `middleware` is not a known config field, and no path is
recorded.

- [ ] **Step 3: Apply the middleware in `buildApiRouter`**

In `packages/bunderstack/src/api/router.ts`, add the option and use the oRPC
builder method `.router()`. That method applies the builder's middleware to
every procedure in the router it receives.

```ts
import type { AnyMiddleware } from '@orpc/server'

export interface BuildApiRouterOptions {
  crud: Record<string, unknown>
  storage: Record<string, unknown>
  realtime?: Record<string, unknown>
  custom?: Record<string, unknown>
  /** Applied to every procedure in the graph, outermost first. */
  middleware?: AnyMiddleware[]
}

export function buildApiRouter(options: BuildApiRouterOptions) {
  const builder = createApiBuilder<
    Record<string, unknown>,
    Record<string, unknown>
  >()
  const health = builder.public
    .route({ method: 'GET', path: '/api/health', tags: ['system'] })
    .output(v.strictObject({ status: v.literal('ok') }))
    .handler(() => ({ status: 'ok' as const }))

  const merged = [
    { health },
    options.crud,
    options.storage,
    options.realtime,
    options.custom,
  ].reduce<Record<string, unknown>>(
    (router, addition) => mergeApiRoutersStrict(router, addition),
    {},
  )

  const middleware = options.middleware ?? []
  if (middleware.length === 0) return merged

  // `.router()` applies the builder's middleware to every procedure inside,
  // so one list covers CRUD, storage, realtime, health, and custom procedures.
  const withMiddleware = middleware.reduce(
    (acc, mw) => acc.use(mw as never),
    builder.public as never,
  ) as ReturnType<typeof createApiBuilder>['public']

  return withMiddleware.router(merged as never) as Record<string, unknown>
}
```

- [ ] **Step 4: Add the config field**

In `packages/bunderstack/src/config.ts`, add `import type { AnyMiddleware } from '@orpc/server'` and the field next to `api`:

```ts
  /**
   * Middleware applied to every procedure in the graph: generated CRUD,
   * storage, realtime, health, and the application's own procedures.
   * Declare each one with `o.middleware(...)` from `defineApi`.
   */
  middleware?: AnyMiddleware[]
```

- [ ] **Step 5: Pass it through**

In `packages/bunderstack/src/index.ts`, add the field to the `buildApiRouter`
call:

```ts
    const nativeRouter = buildApiRouter({
      crud: crudApiRouter as Record<string, unknown>,
      storage: storageApiRouter as Record<string, unknown>,
      realtime: realtimeApiRouter as Record<string, unknown> | undefined,
      custom: customApiRouter as Record<string, unknown> | undefined,
      middleware: options.middleware,
    }) as any
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/bunderstack/src/api/global-middleware.test.ts`
Expected: PASS, 4 tests.

Run: `bun test --cwd packages/bunderstack`
Expected: PASS. No existing test regresses.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/api/router.ts packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/api/global-middleware.test.ts
git commit -m "feat(api): apply configured middleware to the whole procedure graph"
```

---

## Task 5: export the database types

**Files:**
- Modify: `packages/bunderstack/src/db.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/db-types.test.ts`

**Interfaces:**
- Produces: `BunderstackDb<TSchema>` and `BunderstackTx<TSchema>`, both exported from the package root.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack/src/db-types.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { BunderstackDb, BunderstackTx } from './db'

const sqliteSchema = {
  notes: sqliteTable('notes', { id: text('id').primaryKey() }),
}

const pgSchema = {
  notes: pgTable('notes', { id: pgText('id').primaryKey() }),
}

test('BunderstackTx accepts the libSQL transaction callback parameter', () => {
  type Db = BunderstackDb<typeof sqliteSchema>
  type Tx = BunderstackTx<typeof sqliteSchema>

  const accepts = (db: Db) =>
    db.transaction(async (tx) => {
      const typed: Tx = tx
      return typed
    })

  expect(typeof accepts).toBe('function')
})

test('BunderstackTx accepts the Postgres transaction callback parameter', () => {
  type Db = BunderstackDb<typeof pgSchema>
  type Tx = BunderstackTx<typeof pgSchema>

  const accepts = (db: Db) =>
    db.transaction(async (tx) => {
      const typed: Tx = tx
      return typed
    })

  expect(typeof accepts).toBe('function')
})
```

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `bun run typecheck`
Expected: FAIL. `db.ts` has no exported member `BunderstackDb`.

- [ ] **Step 3: Write the implementation**

Append to `packages/bunderstack/src/db.ts`:

```ts
/** The database an application receives on `context.db` and `app.db`. */
export type BunderstackDb<TSchema extends Record<string, unknown>> =
  DbFor<TSchema>

/**
 * The transaction handle inside `db.transaction(...)`. Drizzle publishes no
 * single transaction type for both dialects, so this reads the callback
 * parameter of the resolved database type.
 */
export type BunderstackTx<TSchema extends Record<string, unknown>> = Parameters<
  Parameters<DbFor<TSchema>['transaction']>[0]
>[0]
```

- [ ] **Step 4: Add the public exports**

In `packages/bunderstack/src/index.ts`, add near the other type exports:

```ts
export type { BunderstackDb, BunderstackTx } from './db'
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/bunderstack/src/db-types.test.ts`
Expected: PASS, 2 tests.

Run: `bun run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/db.ts packages/bunderstack/src/index.ts packages/bunderstack/src/db-types.test.ts
git commit -m "feat(db): export BunderstackDb and BunderstackTx"
```

---

## Task 6: extract the list input schema builder

This task changes no behavior. It moves code so that Task 7 can reuse it.

**Files:**
- Create: `packages/bunderstack/src/api/list-input-schema.ts`
- Modify: `packages/bunderstack/src/api/crud-router.ts:150-195`

**Interfaces:**
- Produces:

```ts
export function buildListInputSchema<TTable extends Table>(
  table: TTable,
  options: {
    filterableColumns: readonly string[]
    sortableColumns: readonly string[]
  },
): v.GenericSchema<unknown, unknown>
```

- [ ] **Step 1: Record the current behavior**

Run: `bun test --cwd packages/bunderstack`
Expected: PASS. Write down the number of passing tests. The same number must
pass at the end of this task.

- [ ] **Step 2: Create the shared module**

Create `packages/bunderstack/src/api/list-input-schema.ts`. Move the filter
entry loop and the `listQuerySchema` literal out of `crud-router.ts` without
editing their logic:

```ts
import type { Table } from 'drizzle-orm'

import { createSelectSchema } from 'drizzle-orm/valibot'
import * as v from 'valibot'

import { MAX_LIST_LIMIT } from '../list-query'

/**
 * One filter field per allowed column, typed by the column itself: a scalar
 * for `=`, a list for `IN`, and `null` for `IS NULL`. Query strings are
 * coerced to these types by SmartCoercionHandlerPlugin, so REST and RPC share
 * one contract and nothing has to re-read the raw URL.
 */
function buildFilterEntries(
  table: Table,
  filterableColumns: readonly string[],
): v.ObjectEntries {
  const selectEntries = createSelectSchema(table).entries as Record<
    string,
    v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
  >
  const filterEntries: v.ObjectEntries = {}
  for (const column of filterableColumns) {
    const base = selectEntries[column]
    if (!base) continue
    filterEntries[column] = v.optional(
      v.union([
        // `?filters[col]=null` — a query string cannot carry a real null.
        v.pipe(
          v.literal('null'),
          v.transform(() => null),
        ),
        base,
        v.pipe(v.array(base), v.maxLength(MAX_LIST_LIMIT)),
        v.null(),
      ]),
    )
  }
  return filterEntries
}

export function buildListInputSchema(
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
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      cursor: v.optional(v.string()),
      sort: v.optional(v.picklist(options.sortableColumns as string[])),
      order: v.optional(v.picklist(['asc', 'desc'])),
      q: v.optional(v.pipe(v.string(), v.maxLength(100))),
      count: v.optional(v.boolean()),
      // Always present, even with no filterable columns: clients send `{}`.
      filters: v.optional(v.strictObject(filterEntries)),
    }),
  )
}
```

- [ ] **Step 3: Use it from the CRUD router**

In `packages/bunderstack/src/api/crud-router.ts`, delete the `selectEntries`
constant, the `filterEntries` loop, and the `listQuerySchema` literal. Replace
them with:

```ts
  // Built from runtime column lists, so the schema's own inferred type cannot
  // name the columns; the cast restates it with the literals the caller's
  // `access` config carries. Runtime shape and this type are the same object.
  const listQuerySchema = buildListInputSchema(table, {
    filterableColumns: access.filterableColumns,
    sortableColumns: access.sortableColumns,
  }) as unknown as v.GenericSchema<
    ListInputFor<TTable, TFilterable, TSortable>,
    ListInputFor<TTable, TFilterable, TSortable>
  >
```

Add `import { buildListInputSchema } from './list-input-schema'`.

- [ ] **Step 4: Run the whole package test suite**

Run: `bun test --cwd packages/bunderstack`
Expected: PASS, with the same test count as Step 1.

Run: `bun run typecheck`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/api/list-input-schema.ts packages/bunderstack/src/api/crud-router.ts
git commit -m "refactor(api): extract the list input schema builder"
```

---

## Task 7: `listProcedure`

**Files:**
- Create: `packages/bunderstack/src/api/list-procedure.ts`
- Create: `packages/bunderstack/src/api/list-procedure.test.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**
- Consumes: `buildListInputSchema` from Task 6; `resolveListParams` and `executeList` from `../list-query`.
- Produces:

```ts
export type ListProcedureOptions = {
  filterable?: readonly string[]
  sortable?: readonly string[]
  defaultSort?: { column: string; order: 'asc' | 'desc' }
  searchable?: readonly string[]
}

export function listProcedure<TTable extends Table, TBuilder extends ListCapableBuilder>(
  procedure: TBuilder,
  table: TTable,
  options?: ListProcedureOptions,
): AnyProcedure
```

`ListCapableBuilder` is the structural constraint that Step 3 derives. The
return type must let the client infer `ListResult<TTable['$inferSelect']>`.
Step 5 has a test that fails when that inference breaks.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack/src/api/list-procedure.test.ts`:

```ts
import { PGlite } from '@electric-sql/pglite'
import { createProcedureClient } from '@orpc/server'
import { expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'

import { defineApi } from './builder'
import { createApiContext } from './context'
import { listProcedure } from './list-procedure'

const logs = pgTable('logs', {
  id: text('id').primaryKey(),
  level: text('level').notNull(),
  createdAt: integer('created_at').notNull(),
})

const schema = { logs }

// Same setup shape as crud-router.test.ts, so both suites use one database
// harness.
async function createDb() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  const db = drizzle(client, { schema })
  for (let i = 1; i <= 5; i++) {
    await db.insert(logs).values({
      id: `log_${i}`,
      level: i % 2 === 0 ? 'error' : 'info',
      createdAt: i,
    })
  }
  return db
}

async function callList(input: unknown) {
  const db = await createDb()
  const o = defineApi({ schema })
  const procedure = listProcedure(o.public, logs, {
    filterable: ['level'],
    sortable: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  })

  const client = createProcedureClient(procedure as never, {
    context: createApiContext(
      {
        db: db as never,
        env: {} as never,
        storage: {} as never,
        email: {} as never,
        jobs: {} as never,
        realtime: {} as never,
        auth: {} as never,
      },
      new Request('http://localhost/api/logs'),
    ),
  })

  return client(input as never)
}

test('listProcedure returns items in the configured default order', async () => {
  const result = (await callList({})) as { items: { id: string }[] }

  expect(result.items.map((row) => row.id)).toEqual([
    'log_5',
    'log_4',
    'log_3',
    'log_2',
    'log_1',
  ])
})

test('listProcedure applies a declared filter', async () => {
  const result = (await callList({ filters: { level: 'error' } })) as {
    items: { id: string }[]
  }

  expect(result.items.map((row) => row.id)).toEqual(['log_4', 'log_2'])
})

test('listProcedure reports hasMore and a cursor when the limit truncates', async () => {
  const result = (await callList({ limit: 2 })) as {
    items: unknown[]
    hasMore: boolean
    nextCursor?: string
  }

  expect(result.items).toHaveLength(2)
  expect(result.hasMore).toBe(true)
  expect(typeof result.nextCursor).toBe('string')
})

test('listProcedure returns a total when count is requested', async () => {
  const result = (await callList({ count: true })) as { total?: number }

  expect(result.total).toBe(5)
})

test('listProcedure rejects a column that is not declared sortable', async () => {
  await expect(callList({ sort: 'level' })).rejects.toThrow()
})

test('listProcedure keeps the row type on its output', async () => {
  const o = defineApi({ schema })
  const procedure = listProcedure(o.public, logs, {
    sortable: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  })

  const db = await createDb()
  const client = createProcedureClient(procedure, {
    context: createApiContext(
      {
        db: db as never,
        env: {} as never,
        storage: {} as never,
        email: {} as never,
        jobs: {} as never,
        realtime: {} as never,
        auth: {} as never,
      },
      new Request('http://localhost/api/logs'),
    ),
  })

  const result = await client({})

  // Compiles only when the procedure output keeps `ListResult<typeof logs.$inferSelect>`.
  const level: string = result.items[0]!.level
  const hasMore: boolean = result.hasMore

  expect(level).toBe('error')
  expect(hasMore).toBe(false)
})
```

The last test carries no `as never` on `procedure` or on the client input. That
is deliberate. It fails to compile while the declaration in Step 3 is still
loose.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/bunderstack/src/api/list-procedure.test.ts`
Expected: FAIL. The module `./list-procedure` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/bunderstack/src/api/list-procedure.ts`:

```ts
import type { Table } from 'drizzle-orm'

import { getTableColumns } from 'drizzle-orm'

import type { ResolvedTableAccess } from '../access'

import { executeList, resolveListParams } from '../list-query'
import { buildListInputSchema } from './list-input-schema'

export type ListProcedureOptions = {
  /** Columns a caller may filter on. Others are rejected by the schema. */
  filterable?: readonly string[]
  /** Columns a caller may sort on. Defaults to the default sort column. */
  sortable?: readonly string[]
  defaultSort?: { column: string; order: 'asc' | 'desc' }
  /** Columns the `q` parameter searches. */
  searchable?: readonly string[]
}

/**
 * A list procedure over a table, with the same filter, sort, cursor, and count
 * contract that the generated CRUD list uses.
 *
 * It takes the procedure builder as an argument instead of extending the oRPC
 * builder classes, so the caller keeps direct access to the oRPC chain. It
 * reads no `access` configuration: the base procedure carries the policy.
 */
/**
 * The part of an oRPC builder this helper needs. Any base from `defineApi`
 * satisfies it, including one that already carries `.use(...)` middleware.
 */
export type ListCapableBuilder = {
  input: (schema: never) => {
    handler: (handler: never) => never
  }
}

export function listProcedure<
  TTable extends Table,
  TBuilder extends ListCapableBuilder,
>(procedure: TBuilder, table: TTable, options: ListProcedureOptions = {}) {
  const defaultSort = options.defaultSort ?? { column: 'id', order: 'asc' }
  const sortableColumns = options.sortable ?? [defaultSort.column]

  const inputSchema = buildListInputSchema(table, {
    filterableColumns: options.filterable ?? [],
    sortableColumns,
  })

  // `executeList` reads its policy from a resolved access record. This
  // procedure declares that policy at the call site instead, because the base
  // procedure — not `access.ts` — carries the authorization for it.
  const access = {
    filterableColumns: options.filterable ?? [],
    sortableColumns,
    searchableColumns: options.searchable ?? [],
    defaultSort,
  } as unknown as ResolvedTableAccess

  const idColumn = getTableColumns(table).id
  if (!idColumn) {
    throw new Error(
      `[bunderstack] listProcedure requires an "id" column on table "${getTableName(table)}"`,
    )
  }

  return procedure
    .input(inputSchema as never)
    .handler((async ({ context, input }) => {
      const params = resolveListParams(
        (input ?? {}) as Parameters<typeof resolveListParams>[0],
        access,
      )
      return executeList(
        context.db as never,
        table as never,
        access,
        params,
        idColumn,
      )
    }) as never)
}
```

Add `getTableName` to the `drizzle-orm` import.

**The typing work is the real content of this step.** The runtime body above is
complete. The declaration is not: `ListCapableBuilder` uses `never` for the
schema and the handler, so the returned procedure loses its output type and the
client cannot infer `ListResult`.

Derive the real constraint from the oRPC builder types in
`node_modules/@orpc/server/dist/index.d.mts`. The relevant interfaces are
`BuilderWithMiddlewares` (line 64), which declares
`input<T extends AnySchema>(schema: T): BuilderWithInput<…>`, and
`BuilderWithInput` (line 135), which declares `handler<T>(…): DecoratedProcedure<…>`.
Constrain `TBuilder` so that `.input()` and `.handler()` keep their generics,
and let the return type flow from `DecoratedProcedure`.

Step 5 proves the result. Do not finish this task while the inference test
fails.

- [ ] **Step 4: Add the public export**

In `packages/bunderstack/src/index.ts`:

```ts
export { listProcedure } from './api/list-procedure'
export type { ListProcedureOptions } from './api/list-procedure'
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/bunderstack/src/api/list-procedure.test.ts`
Expected: PASS, 6 tests.

Run: `bun run typecheck`
Expected: exit code 0. This is the gate for the declaration work in Step 3. A
loose signature makes the inference test fail here even though `bun test`
passes, because Bun strips the types instead of checking them.

Run: `bun test --cwd packages/bunderstack`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/api/list-procedure.ts packages/bunderstack/src/api/list-procedure.test.ts packages/bunderstack/src/index.ts
git commit -m "feat(api): add listProcedure for custom list endpoints"
```

---

## Task 8: move the examples to the module-scope pattern

**Files:**
- Modify: `examples/twitter-tanstack/src/bunderstack.ts`
- Create: `examples/twitter-tanstack/src/api.ts`
- Modify: `examples/todo/src/bunderstack.ts` (only if it declares an `api` callback)

**Interfaces:**
- Consumes: `defineApi` from Task 1; the object form of `api` from Task 2.

- [ ] **Step 1: Move the twitter feed procedure to its own module**

Create `examples/twitter-tanstack/src/api.ts`. Move the `feed` procedure out of
`bunderstack.ts` without changing its body:

```ts
import { defineApi } from 'bunderstack'
import { desc, eq, sql } from 'drizzle-orm'
import * as v from 'valibot'

import * as schema from './schema'

const o = defineApi({ schema })

export const api = {
  feed: o.public
    .route({ method: 'GET', path: '/api/feed' })
    .input(
      v.optional(
        v.object({
          limit: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
            20,
          ),
        }),
      ),
    )
    .handler(async ({ context, input }) => {
      const limit = input?.limit ?? 20
      const rows = await context.db
        .select({
          post: schema.posts,
          author: {
            id: schema.user.id,
            name: schema.user.name,
            image: schema.user.image,
          },
          likeCount: sql<number>`count(${schema.likes.id})`,
        })
        .from(schema.posts)
        .innerJoin(schema.user, eq(schema.posts.userId, schema.user.id))
        .leftJoin(schema.likes, eq(schema.likes.postId, schema.posts.id))
        .groupBy(schema.posts.id)
        .orderBy(desc(schema.posts.createdAt))
        .limit(limit)
      return rows
    }),
}
```

- [ ] **Step 2: Use the object form in the example config**

In `examples/twitter-tanstack/src/bunderstack.ts`, delete the `api: (o) => ({…})`
block and the now-unused `desc`, `eq`, `sql`, and `valibot` imports. Add:

```ts
import { api } from './api'
```

and set the option to `api,` inside `createBunderstack({ … })`.

- [ ] **Step 3: Check the other examples**

Run: `grep -rn "api: (o)" examples/`
For every match, apply the same move: a new `src/api.ts` module with
`defineApi`, and `api,` in the configuration.

- [ ] **Step 4: Typecheck the examples**

Run: `bun run typecheck:examples`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "refactor(examples): declare the api in its own module"
```

---

## Task 9: documentation and release

**Files:**
- Modify: `docs/MIGRATION-0.17.md`
- Modify: `packages/bunderstack/README.md`
- Modify: the website page that documents custom procedures
- Modify: `packages/*/package.json` (version bump)

- [ ] **Step 1: Find the pages that show the callback form**

Run: `grep -rln "api: (o)" docs/ website/src/ packages/*/README.md templates/`
Update every hit to the module-scope pattern from Task 8.

- [ ] **Step 2: Write the migration section**

Append to `docs/MIGRATION-0.17.md`:

````markdown
## Declaring the API

The `api` option now accepts the finished router object. Declare the builder at
module scope with `defineApi`, and import the bases into the router modules.

```ts
// api/base.ts
import { defineApi } from 'bunderstack'

import { envSchema } from '../env'
import { schema } from '../schema'

export const o = defineApi({ schema, env: envSchema })
export const publicProcedure = o.public
export const protectedProcedure = o.protected
```

```ts
// api/index.ts
import { protectedProcedure } from './base'

export const api = {
  stats: protectedProcedure.handler(({ context }) => countRows(context.db)),
}
```

```ts
createBunderstack({ api })
```

The callback form still works. No change is required.

## Middleware for the whole graph

The `middleware` option applies an oRPC middleware to every procedure: the
generated CRUD, storage, realtime, health, and your own procedures.

```ts
const instrumentation = o.middleware(async ({ path, next }) => {
  const startedAt = performance.now()
  try {
    return await next()
  } finally {
    metrics.record(path.join('.'), performance.now() - startedAt)
  }
})

createBunderstack({ middleware: [instrumentation], api })
```

Two rules apply.

A global middleware runs before authentication. `context.user` is not available
inside it. Use `context.peekSession()` to read a session that some later code
already resolved. Use it for observability only. Never use it for
authorization.

A realtime subscription lives for a long time. A `finally` block runs when the
stream closes, not when the subscription starts. Filter such paths with the
`path` argument when that matters.

## New exports

- `defineApi({ schema, env })`
- `listProcedure(procedure, table, options)`
- `BunderstackDb<TSchema>` and `BunderstackTx<TSchema>`
````

- [ ] **Step 3: Bump the versions**

Set `version` to `0.17.0-beta.6` in `packages/bunderstack/package.json`,
`packages/bunderstack-query/package.json`,
`packages/bunderstack-sync/package.json`, and
`packages/bunderstack-start/package.json`.

- [ ] **Step 4: Run the full verification**

Run: `bun run build`
Expected: exit code 0.

Run: `bun test`
Expected: PASS.

Run: `bun run typecheck:all`
Expected: exit code 0.

Run: `bun run verify:consumer`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add docs/ website/ packages/ templates/
git commit -m "docs: document module-scope api declaration and global middleware"
```

---

## Task 10: point the application at the local build

**Files:**
- Modify: `/Users/kirill/Projects/bunderstack-project/hrbreakers.com-bunderstack/package.json`

This task makes Tasks 11–14 possible. Revert it in Task 14.

- [ ] **Step 1: Build the packages**

In the framework worktree:

```bash
bun run build
```

Expected: exit code 0.

- [ ] **Step 2: Register the local packages**

```bash
cd packages/bunderstack && bun link
cd ../bunderstack-query && bun link
cd ../bunderstack-sync && bun link
cd ../bunderstack-start && bun link
```

- [ ] **Step 3: Link them into the application**

```bash
cd /Users/kirill/Projects/bunderstack-project/hrbreakers.com-bunderstack
bun link bunderstack bunderstack-query bunderstack-sync bunderstack-start
```

- [ ] **Step 4: Confirm the link resolves**

Run: `bun -e "console.log(require.resolve('bunderstack'))"`
Expected: a path inside `.worktrees/orpc-api-spike/packages/bunderstack`.

- [ ] **Step 5: Confirm the application still builds**

Run: `bun run typecheck` (or the script the application uses for TypeScript)
Expected: the same result as before the link. Record any pre-existing error, so
later tasks do not blame it on this work.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: link the local bunderstack build for the api migration"
```

---

## Task 11: create the application base module

**Repository:** `hrbreakers.com-bunderstack`

**Files:**
- Create: `src/bunderstack/api/base.ts`
- Modify: `src/bunderstack/api/index.ts`
- Modify: `src/bunderstack/index.ts`
- Modify: `src/bunderstack/api/public.ts`, `telegram.ts`, `adaptation.ts`, `credit.ts`, `admin.ts`
- Test: `src/bunderstack/api/router.test.ts`

**Interfaces:**
- Produces: `publicProcedure`, `protectedProcedure`, `adminProcedure`, and `instrumentation`, all exported from `src/bunderstack/api/base.ts`.
- Produces: `api`, exported from `src/bunderstack/api/index.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/bunderstack/api/router.test.ts`:

```ts
test('the api router exposes every namespace as a plain object', async () => {
  const { api } = await import('./index')

  expect(Object.keys(api).sort()).toEqual([
    'adaptation',
    'admin',
    'credit',
    'public',
    'telegram',
  ])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/bunderstack/api/router.test.ts`
Expected: FAIL. `index.ts` exports `createHRBreakersApi`, not `api`.

- [ ] **Step 3: Create the base module**

Create `src/bunderstack/api/base.ts`:

```ts
import { defineApi } from 'bunderstack'
import * as Sentry from '@sentry/node'

import { logToPostHog } from '@/lib/analytics/logs'

import { envSchema } from '../env'
import { schema } from '../schema'

export const o = defineApi({ schema, env: envSchema })

/**
 * Registered in `createBunderstack({ middleware })`, so it covers the
 * generated CRUD and storage procedures as well as the ones declared here.
 */
export const instrumentation = o.middleware(async ({ context, path, next }) => {
  const name = path.join('.')
  return Sentry.startSpan(
    { name, op: 'rpc.server', attributes: { 'rpc.method': name } },
    async () => {
      const startedAt = performance.now()
      try {
        const result = await next()
        logToPostHog('info', `oRPC ${name}`, {
          path: name,
          duration_ms: Math.round(performance.now() - startedAt),
          userId: context.peekSession()?.user?.id,
          posthogDistinctId: context.peekSession()?.user?.id,
        })
        return result
      } catch (error) {
        logToPostHog('error', `oRPC ${name}`, {
          path: name,
          duration_ms: Math.round(performance.now() - startedAt),
          userId: context.peekSession()?.user?.id,
          posthogDistinctId: context.peekSession()?.user?.id,
          error: error instanceof Error ? error.message : 'Unknown',
        })
        Sentry.captureException(error)
        throw error
      }
    },
  )
})

export const publicProcedure = o.public
export const protectedProcedure = o.protected

export const adminProcedure = o.protected.use(async ({ context, next, errors }) => {
  if (context.user.role !== 'admin' && context.user.role !== 'superadmin') {
    throw errors.FORBIDDEN({ message: 'Admin access required' })
  }
  return next()
})
```

This body matches the original middleware in `api/index.ts:29-60`. It logs
exactly one line per call: `info` on success, `error` on failure.

- [ ] **Step 4: Convert one router and check it compiles**

In `src/bunderstack/api/telegram.ts`, delete the factory wrapper and the
`HRBreakersProcedures` import. Export a plain object:

```ts
import { protectedProcedure } from './base'

export const telegramRouter = {
  getStats: protectedProcedure.handler(async ({ context }) => {
    return getTelegramStats(context.db)
  }),
  // …the remaining procedures, unchanged inside…
}
```

Run: `bun run typecheck`
Expected: errors only in the files not yet converted.

- [ ] **Step 5: Convert the remaining routers**

Apply the same change to `public.ts`, `adaptation.ts`, `credit.ts`, and
`admin.ts`. Export `publicRouter`, `adaptationRouter`, `creditRouter`, and
`adminRouter`. Do not change any handler body in this step.

- [ ] **Step 6: Rewrite the index module**

Replace the body of `src/bunderstack/api/index.ts`:

```ts
import { adaptationRouter } from './adaptation'
import { adminRouter } from './admin'
import { creditRouter } from './credit'
import { publicRouter } from './public'
import { telegramRouter } from './telegram'

export const api = {
  public: publicRouter,
  telegram: telegramRouter,
  adaptation: adaptationRouter,
  credit: creditRouter,
  admin: adminRouter,
}

export type HRBreakersApiRouter = typeof api
```

The file no longer exports `createHRBreakersApi`, `createHRBreakersProcedures`,
`HRBreakersProcedures`, or `HRBreakersApiBuilder`.

- [ ] **Step 7: Update the application configuration**

In `src/bunderstack/index.ts`, replace `api: (o) => createHRBreakersApi(o)` with:

```ts
    middleware: [instrumentation],
    api,
```

and change the import to `import { api } from './api'` plus
`import { instrumentation } from './api/base'`.

- [ ] **Step 8: Run the tests and the typecheck**

Run: `bun test src/bunderstack/`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit code 0.

- [ ] **Step 9: Commit**

```bash
git add src/bunderstack/
git commit -m "refactor(api): declare procedures in plain modules"
```

---

## Task 12: prove the role, then remove the role middleware

**Repository:** `hrbreakers.com-bunderstack`

**Files:**
- Test: `src/bunderstack/api/role.test.ts`
- Modify: `src/bunderstack/api/base.ts`

Do not remove the middleware before Step 3 passes.

- [ ] **Step 1: Write the test**

Create `src/bunderstack/api/role.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { app } from '../index'
import { user } from '../schema/auth'

test('the Better Auth session carries the stored role', async () => {
  const email = `role-${Date.now()}@example.com`

  await app.auth.api.signUpEmail({
    body: { email, password: 'test-password-123', name: 'Role Test' },
  })

  await app.db
    .update(user)
    .set({ role: 'admin' })
    .where(eq(user.email, email))

  const signIn = await app.auth.api.signInEmail({
    body: { email, password: 'test-password-123' },
    asResponse: true,
  })

  const headers = new Headers()
  headers.set('cookie', signIn.headers.get('set-cookie') ?? '')

  const session = await app.auth.api.getSession({ headers })

  expect(session?.user.role).toBe('admin')
})
```

Add `import { eq } from 'drizzle-orm'`.

- [ ] **Step 2: Run the test**

Run: `bun test src/bunderstack/api/role.test.ts`

- [ ] **Step 3: Branch on the result**

If the test PASSES: the role arrives from the session. `o.protected` therefore
already provides `context.user.role`. Confirm that `src/bunderstack/api/base.ts`
contains no role-hydration middleware, and that `adminProcedure` reads
`context.user.role` directly. Continue to Step 4.

If the test FAILS: the role does not arrive from the session. Keep a
hydration middleware, but move it into `base.ts` as a `.use()` on
`o.protected`, above `adminProcedure`. Copy the body from the original
`api/index.ts:69-83`. Record the failure in the commit message. Then continue
to Step 4.

- [ ] **Step 4: Run the admin procedures**

Run: `bun test src/bunderstack/`
Expected: PASS. The admin procedures still reject a non-admin caller.

- [ ] **Step 5: Commit**

```bash
git add src/bunderstack/api/
git commit -m "test(api): prove the session carries the user role"
```

---

## Task 13: apply the remaining cleanups

**Repository:** `hrbreakers.com-bunderstack`

**Files:**
- Modify: `src/bunderstack/api/adaptation.ts`, `credit.ts`, `admin.ts`, `telegram.ts`
- Modify: the admin client code that reads `{ items, totalCount }`

- [ ] **Step 1: Replace the ORPCError constructions**

In every API file, replace `throw new ORPCError('CODE', { message })` with the
`errors` argument of the handler:

```ts
.handler(async ({ context, input, errors }) => {
  const adaptation = await context.db.query.adaptations.findFirst({
    where: eq(adaptations.id, input.id),
  })
  if (!adaptation || adaptation.userId !== context.user.id) {
    throw errors.NOT_FOUND({ message: 'Adaptation not found' })
  }
  // …
})
```

The framework declares `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `PAYLOAD_TOO_LARGE`, and `TOO_MANY_REQUESTS`. The application uses
four of them. Remove the `ORPCError` import from every file that no longer
needs it.

- [ ] **Step 2: Read the environment from the context**

In `src/bunderstack/api/credit.ts`, delete `import { env } from '../env'` and
read `context.env` inside each handler instead.

`getAvailableProviders` currently takes no context. Change it to:

```ts
getAvailableProviders: protectedProcedure.handler(({ context }) => {
  return {
    stripe: !!(stripe && context.env.STRIPE_PRICE_10),
    platega: !!(context.env.PLATEGA_MERCHANT_ID && context.env.PLATEGA_SECRET_KEY),
  }
}),
```

- [ ] **Step 3: Replace the `any` database types**

In `src/bunderstack/api/adaptation.ts`, import the public types and use them:

```ts
import type { BunderstackDb, BunderstackTx } from 'bunderstack'

import type { schema } from '../schema'

type Db = BunderstackDb<typeof schema>
type Tx = BunderstackTx<typeof schema>

async function assertAndSpendCredits(
  database: Db,
  user: { id: string; email: string },
  creditsNeeded: number,
  isFast: boolean,
) {
  // …
  await database.transaction(async (tx: Tx) => {
    // …
  })
}
```

Apply the same change to `startGeneration(database: Db, …)`.

- [ ] **Step 4: Run the typecheck**

Run: `bun run typecheck`
Expected: exit code 0. If a real type error appears inside a handler, fix the
handler. Do not restore `any`.

- [ ] **Step 5: Replace the three list blocks**

In `src/bunderstack/api/admin.ts`, replace `getLogs`, `getTransactions`, and
`getAdaptations`:

```ts
import { listProcedure } from 'bunderstack'

import { adaptations } from '../schema/adaptations'
import { creditTransactions } from '../schema/credits'
import { appLogs } from '../schema/logs'

export const adminRouter = {
  // …
  getLogs: listProcedure(adminProcedure, appLogs, {
    filterable: ['level', 'action', 'userId'],
    sortable: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  }),

  getTransactions: listProcedure(adminProcedure, creditTransactions, {
    filterable: ['type', 'userId'],
    sortable: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  }),

  getAdaptations: listProcedure(adminProcedure, adaptations, {
    filterable: ['status', 'userId'],
    sortable: ['createdAt'],
    defaultSort: { column: 'createdAt', order: 'desc' },
  }),
  // …
}
```

Delete the `conditions.reduce(…)` helpers that these three procedures used.

- [ ] **Step 6: Update the admin client**

Run: `grep -rn "totalCount" src/`

Each hit reads the old response shape. The new shape is
`{ items, hasMore, nextCursor, total, limit, offset, sort, order }`. Replace
`totalCount` with `total`, and pass `count: true` in the query input where the
view shows a total. Where the view has a "load more" control, use `nextCursor`
instead of `offset`.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `bun test src/`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit code 0.

- [ ] **Step 8: Check the admin pages in a browser**

Start the application. Open each admin page that lists logs, transactions, or
adaptations. Confirm that rows appear, that the filters work, and that the
total matches the previous behavior.

- [ ] **Step 9: Commit**

```bash
git add src/
git commit -m "refactor(api): use typed errors, context env, public db types, and listProcedure"
```

---

## Task 14: release and unlink

- [ ] **Step 1: Publish the framework beta**

`scripts/publish-changed.ts` publishes every workspace package whose
`package.json` version is ahead of the registry. Task 9 already set the four
versions to `0.17.0-beta.6`.

Check what it would publish first:

```bash
bun scripts/publish-changed.ts --dry-run
```

Expected: it lists `bunderstack`, `bunderstack-query`, `bunderstack-sync`, and
`bunderstack-start` at `0.17.0-beta.6`.

The repository publishes from CI (`.github/workflows/publish.yml`) on a push to
`main`. Push the branch and let the workflow publish. Do not run the script
without `--dry-run` from a local machine unless the user asks for it — this
publishes to the public npm registry, and a published version cannot be
replaced.

Wait until all four versions resolve on the registry:

```bash
npm view bunderstack@0.17.0-beta.6 version
```

- [ ] **Step 2: Remove the links from the application**

```bash
cd /Users/kirill/Projects/bunderstack-project/hrbreakers.com-bunderstack
bun unlink bunderstack bunderstack-query bunderstack-sync bunderstack-start
```

- [ ] **Step 3: Depend on the published version**

Set all four `bunderstack*` dependencies in `package.json` to `0.17.0-beta.6`.

Run: `bun install`
Expected: exit code 0.

- [ ] **Step 4: Verify against the published package**

Run: `bun test src/`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit code 0.

- [ ] **Step 5: Confirm the acceptance criteria**

Run each command and confirm the expected result:

```bash
grep -rn "HRBreakersProcedures" src/          # no matches
grep -rn "createXRouter\|create.*Router(" src/bunderstack/api/   # no factory definitions
grep -rn "os.\$context" src/                  # no matches
grep -rn "BunderstackApiBuilder" src/         # no matches
grep -rn ": any" src/bunderstack/api/         # no matches
```

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: depend on bunderstack 0.17.0-beta.6"
```

---

## Acceptance Criteria

The spec lists eleven criteria. This table maps each one to the task that
satisfies it.

| Spec criterion | Task |
| --- | --- |
| 1. No router factory takes a procedure bag | 11, verified in 14 Step 5 |
| 2. No import cycle between routers and index | 11 |
| 3. No hand-written `BunderstackApiBuilder<…>` | 11, verified in 14 Step 5 |
| 4. No `os.$context<…>()` in the application | 11, verified in 14 Step 5 |
| 5. Middleware runs for CRUD, storage, and custom procedures | 4 |
| 6. `peekSession()` returns `undefined` and starts no resolution | 3 |
| 7. A webhook with a global middleware resolves no session | 4 |
| 8. `context.user.role` carries the Better Auth role | 12 |
| 9. One input-schema builder for `listProcedure` and CRUD | 6, 7 |
| 10. No `any` in the application API layer | 13, verified in 14 Step 5 |
| 11. Examples and documentation show the module-scope pattern | 8, 9 |
