# Declarative Runtime and Testing Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace eager `createBunderstack()` runtimes with a reusable `bunderstack()` declaration that owns production startup, pure Blueprint metadata, and isolated typed test fixtures.

**Architecture:** Split the current root implementation into a pure branded backend declaration and an internal runtime materializer. The declaration computes deployment metadata synchronously; `.start()` resolves one complete env source into a production runtime, while `.test()` dynamically loads test-only infrastructure and materializes the same declaration with isolated adapters. Migrate the framework, template, examples, generated documentation, and consumer verification before removing the temporary compatibility shim.

**Tech Stack:** Bun 1.3+, TypeScript 5.8+, `bun:test`, Drizzle ORM 0.45.x, Better Auth 1.x, oRPC `2.0.0-beta.26`, libSQL, PGlite.

**Spec:** `docs/superpowers/specs/2026-08-27-declarative-runtime-testing-design.md`

## Global Constraints

- `bunderstack(config)` is synchronous and performs no database, filesystem, network, worker, or global-environment mutation.
- `backend.manifest` is pure deployment metadata; Blueprint remains version 1 and manifest remains version 3.
- `backend.start({ env })` treats `env` as the entire source and never merges it with `process.env`.
- Deployment topology is static; do not add resource factories or a general `env()` DSL.
- `backend.test()` never accepts overrides for schema, access, auth, API, middleware, jobs, or storage bucket policy.
- Test ownership is lexical through `AsyncDisposable`; do not add `bun:test` hooks, a preload, or a process-global registry.
- The final public surface contains `bunderstack()`, not `createBunderstack()`; a temporary shim may exist only while repository consumers are migrated.
- Production's eagerly evaluated module graph must not include the fixture implementation or `bun:test`.
- Use Bun commands, preserve current package versions and pinned oRPC versions, and run `bun run verify:consumer` after public type changes.

---

### Task 1: Split the declaration from runtime materialization

**Files:**
- Create: `packages/bunderstack/src/backend.ts`
- Create: `packages/bunderstack/src/backend-internals.ts`
- Create: `packages/bunderstack/src/runtime.ts`
- Create: `packages/bunderstack/src/backend.test.ts`
- Modify: `packages/bunderstack/src/index.ts:1-917`
- Modify: `packages/bunderstack/src/config.ts:133-322`
- Modify: `packages/bunderstack/src/jobs/define.ts:1-8`
- Modify: `packages/bunderstack/src/api/context.ts:1-8`

**Interfaces:**
- Produces: `bunderstack(config): BunderstackBackend<TApp>`.
- Produces: `BunderstackBackend<TApp> = { readonly manifest; start(options?); test(options?) }`.
- Produces: `StartOptions = { env?: Record<string, string | undefined> }`.
- Produces internally: `materializeRuntime(declaration, source, overrides): Promise<TApp>`.
- Produces internally: `BACKEND_INTERNALS` brand and materializer handle for `bunderstack/testing`.

- [ ] **Step 1: Add failing declaration lifecycle tests**

Create `backend.test.ts` with a counting database adapter and these concrete assertions:

```ts
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { DatabaseAdapter } from './database/adapter'
import { bunderstack } from './index'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

test('bunderstack is synchronous, branded, and does not connect', () => {
  let connects = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      connects++
      throw new Error('must not connect while declaring')
    },
    async migrate() {},
  }
  const backend = bunderstack({ schema: { notes }, database: { adapter } })
  expect(connects).toBe(0)
  expect(backend.manifest.database.tables.map((t) => t.physicalName)).toContain(
    'notes',
  )
})

test('explicit start env does not inherit process.env', async () => {
  const previous = process.env.ADMIN_TOKEN
  process.env.ADMIN_TOKEN = 'ambient'
  try {
    const backend = bunderstack({
      schema: { notes },
      database: { adapter: libsql() },
      env: { server: { ADMIN_TOKEN: v.string() } },
    })
    await expect(
      backend.start({ env: { DATABASE_URL: ':memory:' } }),
    ).rejects.toThrow(/ADMIN_TOKEN/)
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = previous
  }
})
```

- [ ] **Step 2: Run the focused tests and confirm the missing API**

Run: `bun test packages/bunderstack/src/backend.test.ts`

Expected: FAIL because `bunderstack` is not exported.

- [ ] **Step 3: Extract runtime types and the existing runtime body**

Move `AuthInstance`, `StorageFacade`, worker option types, `BucketNamesOf`, and `BunderstackApp` from `index.ts` to `runtime.ts`. Move the current async body at `index.ts:293-800` behind this exact internal signature, preserving its handler/storage/auth/jobs/lifecycle behavior:

```ts
export type RuntimeOverrides = {
  database?: DatabaseConnection
  resolvedStorage?: ResolvedStorageBuckets
  emailAdapter?: EmailAdapter
  forceMemoryRealtime?: boolean
  backgroundAutoStart?: false
}

export async function materializeRuntime<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined,
  TStorage extends StorageConfigInput | undefined,
  TEnv extends EnvConfigInput | undefined,
  TJobsDefs extends JobsDefs | undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined,
  TRealtime,
>(
  declaration: ResolvedDeclaration<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >,
  source: Record<string, string | undefined>,
  overrides: RuntimeOverrides = {},
): Promise<BunderstackApp<
  TSchema,
  TAccess,
  BucketNamesOf<TStorage>,
  TEnv,
  TJobsDefs,
  TCustomApiRouter,
  TRealtime
>>
```

Use `source` for `validateEnv`, `resolveConfig`, Redis prefix, and every platform override. Remove reads of `options.processEnv` from the materializer. Keep the existing `AggregateError` cleanup path.

- [ ] **Step 4: Implement the pure backend declaration**

In `backend-internals.ts`, define a non-exported-package brand shared by the root and testing modules:

```ts
export const BACKEND_INTERNALS: unique symbol = Symbol.for(
  'bunderstack.backend-internals',
)

export type BackendInternals<TApp> = {
  start(
    source: Record<string, string | undefined>,
    overrides?: RuntimeOverrides,
  ): Promise<TApp>
  declaration: ResolvedDeclaration
}
```

In `backend.ts`, evaluate and validate job definitions once, resolve storage against `{}` only for manifest description, build manifest version 3, and return:

```ts
export type StartOptions = {
  env?: Record<string, string | undefined>
}

export type BunderstackBackend<TApp> = {
  readonly manifest: BunderstackManifest
  start(options?: StartOptions): Promise<TApp>
  test(options?: import('./testing').TestOptions): Promise<
    import('./testing').TestFixture<TApp>
  >
  readonly [BACKEND_INTERNALS]: BackendInternals<TApp>
}

export function bunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined = undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  const TJobsDefs extends JobsDefs | undefined = undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined = undefined,
  const TRealtime = undefined,
>(
  config: BunderstackDefinitionConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >,
): BunderstackBackend<
  BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >
> {
  const declaration = resolveDeclaration(config)
  const manifest = buildManifestFromDeclaration(declaration)
  return {
    manifest,
    start: ({ env } = {}) =>
      materializeRuntime(
        declaration,
        env ?? (process.env as Record<string, string | undefined>),
      ),
    test: async (options) =>
      (await import('./testing')).createTestApp(backend, options),
    [BACKEND_INTERNALS]: { declaration, start: materialize },
  }
}
```

The dynamic import argument must remain the literal `'./testing'`.

- [ ] **Step 5: Keep a temporary repository-only compatibility shim**

Until Task 8, retain `createBunderstack` as a deprecated wrapper that removes `processEnv` before declaration and forwards it to `.start()`:

```ts
/** @deprecated Repository migration shim. Removed before release. */
export async function createBunderstack(config: LegacyBunderstackConfig) {
  const { processEnv, ...declaration } = config
  return bunderstack(declaration).start({ env: processEnv })
}
```

Do not document or add this shim to new consumer tests.

- [ ] **Step 6: Re-export moved runtime types and fix internal imports**

Make `index.ts` a public barrel over `backend.ts` and `runtime.ts`. Change `jobs/define.ts` and `api/context.ts` to import `StorageFacade`/`AuthInstance` from `runtime.ts`, not the root barrel.

- [ ] **Step 7: Run lifecycle, env, and type tests**

Run: `bun test packages/bunderstack/src/backend.test.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/infer-client.test.ts`

Expected: PASS; no declaration calls the counting adapter.

- [ ] **Step 8: Commit the declaration/runtime split**

```bash
git add packages/bunderstack/src/backend.ts packages/bunderstack/src/backend-internals.ts packages/bunderstack/src/runtime.ts packages/bunderstack/src/backend.test.ts packages/bunderstack/src/index.ts packages/bunderstack/src/config.ts packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/api/context.ts
git commit -m "feat: separate bunderstack declarations from runtimes"
```

---

### Task 2: Make Blueprint generation consume the pure backend

**Files:**
- Modify: `packages/bunderstack/src/blueprint-generator.ts:109-207`
- Modify: `packages/bunderstack/src/blueprint-generator.test.ts`
- Modify: `packages/bunderstack/src/env.ts:150-154`
- Modify: `packages/bunderstack/src/env.test.ts:186-195`
- Modify: `packages/bunderstack/src/provision.ts:104-127`
- Modify: `packages/bunderstack/src/provision.test.ts:1-45`

**Interfaces:**
- Consumes: branded `BunderstackBackend` and `backend.manifest` from Task 1.
- Produces: Blueprint entry contract “module must export backend”.
- Removes: `BUNDERSTACK_INTROSPECT` behavior from generation, env validation, adapters, and provision.

- [ ] **Step 1: Change Blueprint fixtures to export a declaration that cannot boot**

Add a generator test fixture whose adapter `connect()` throws and whose module exports:

```ts
export const backend = bunderstack({
  schema,
  database: { adapter: throwingAdapter },
  jobs: (j) => j.define({ nightly: j.cron({ schedule: '0 3 * * *', handler() {} }) }),
})
```

Assert `generateBlueprint()` succeeds, contains `nightly`, and leaves the caller's `BUNDERSTACK_INTROSPECT` value untouched. Add a negative fixture exporting `{ manifest }` without the backend brand and expect `must export backend`.

- [ ] **Step 2: Run the generator test and verify the old app contract fails it**

Run: `bun test packages/bunderstack/src/blueprint-generator.test.ts`

Expected: FAIL because the generator still reads `module.app` and mutates env.

- [ ] **Step 3: Replace app introspection with branded backend loading**

Replace lines 146-207 with:

```ts
const module = await import(
  `${pathToFileURL(entryPath).href}?blueprint=${Date.now()}`
)
const backend = module.backend
if (!isBunderstackBackend(backend)) {
  throw new Error(`[bunderstack] ${entry} must export backend`)
}
const manifest = parseManifest(backend.manifest)
```

Keep package script checks, migration-journal detection, atomic output, `--check`, manifest version 3, and Blueprint version 1 unchanged. Delete the `finally` block that closes app/restores env.

- [ ] **Step 4: Delete introspection exceptions**

Remove the lenient `BUNDERSTACK_INTROSPECT` branch from `validateEnv`, the early return from `provision`, and the corresponding tests. Change adapter connect options in Task 3 rather than retaining mock-connection introspection.

- [ ] **Step 5: Run Blueprint and env/provision tests**

Run: `bun test packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/env.test.ts packages/bunderstack/src/provision.test.ts`

Expected: PASS and `rg 'BUNDERSTACK_INTROSPECT' packages/bunderstack/src` returns no matches.

- [ ] **Step 6: Commit pure Blueprint generation**

```bash
git add packages/bunderstack/src/blueprint-generator.ts packages/bunderstack/src/blueprint-generator.test.ts packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts packages/bunderstack/src/provision.ts packages/bunderstack/src/provision.test.ts
git commit -m "feat: generate blueprints from backend declarations"
```

---

### Task 3: Add isolated database targets and the base fixture lifecycle

**Files:**
- Create: `packages/bunderstack/src/testing/database.ts`
- Create: `packages/bunderstack/src/testing/fixture.ts`
- Create: `packages/bunderstack/src/testing/fixture.test.ts`
- Modify: `packages/bunderstack/src/testing.ts`
- Modify: `packages/bunderstack/src/database/adapter.ts:4-26`
- Modify: `packages/bunderstack/src/database/libsql.ts:6-27`
- Modify: `packages/bunderstack/src/database/pglite.ts:10-32`
- Modify: `packages/bunderstack/src/database/bun-sql.ts:6-22`
- Modify: `packages/bunderstack/src/database/postgres-js.ts:10-33`
- Modify: `packages/bunderstack/src/db.ts:54-73`
- Modify: `packages/bunderstack/src/provision.ts:42-127`

**Interfaces:**
- Produces: `TestDatabaseTarget`, `TestDatabaseStrategy`, and optional `DatabaseAdapter.testing.createTarget()`.
- Produces: `TestOptions` with only `env` and `database` controls.
- Produces: `createTestApp(backend, options): Promise<TestFixture<TApp>>`.
- Produces: idempotent `TestFixture.close()` and `[Symbol.asyncDispose]()`.

- [ ] **Step 1: Add failing isolation, explicit-env, concurrency, and cleanup tests**

Cover these cases in `testing/fixture.test.ts` using a libSQL backend:

```ts
test('fixtures provision independently and dispose lexically', async () => {
  const backend = bunderstack({ schema: { notes }, database: { adapter: libsql() } })
  await using a = await backend.test()
  await using b = await backend.test()
  await a.app.db.insert(notes).values({ id: 'only-a' })
  expect(await b.app.db.select().from(notes)).toEqual([])
  await a.close()
  expect((await b.app.db.select().from(notes))).toEqual([])
})

test('external adapters refuse production URLs without a strategy', async () => {
  const backend = bunderstack({ schema: pgSchema, database: { adapter: bunSql() } })
  await expect(backend.test()).rejects.toThrow(/explicit test database strategy/)
})
```

Also inject an adapter whose runtime creation fails after allocating a target and assert its target disposer still runs once.

- [ ] **Step 2: Run the fixture test and confirm the testing surface is missing**

Run: `bun test packages/bunderstack/src/testing/fixture.test.ts`

Expected: FAIL because `DatabaseAdapter.testing` and `createTestApp` do not exist.

- [ ] **Step 3: Define database testing contracts**

Add to `database/adapter.ts`:

```ts
export type TestDatabaseTarget = AsyncDisposable & {
  connection: DatabaseConnection
}

export type TestDatabaseTargetOptions = { mode: 'memory' | 'temporary' }

export type TestDatabaseStrategy = {
  createTarget(options: TestDatabaseTargetOptions): Promise<TestDatabaseTarget>
}

export type DatabaseAdapter = {
  readonly dialect: Dialect
  readonly driver: Driver
  connect<TSchema extends Record<string, unknown>>(
    schema: TSchema,
    connection: DatabaseConnection,
  ): Promise<DatabaseConnectionResult<TSchema>>
  migrate(db: AnyDb, migrationsFolder: string): Promise<void>
  testing?: TestDatabaseStrategy
}
```

Remove `DatabaseConnectOptions.introspect` and every `drizzle.mock()` branch.

- [ ] **Step 4: Implement built-in libSQL and PGlite targets**

For memory mode return `:memory:` (libSQL) or `memory://` (PGlite) with a no-op async disposer. For temporary mode use `mkdtemp(join(tmpdir(), 'bunderstack-test-'))`, return a file/directory URL, and remove exactly that created directory in an idempotent disposer. Do not give bun-sql or postgres-js a default strategy.

- [ ] **Step 5: Implement exact provisioning modes**

Add an internal test provisioning entry:

```ts
export type TestSchemaMode = 'auto' | 'push' | 'migrations'

export async function provisionForTest(
  app: object,
  mode: TestSchemaMode,
): Promise<void>
```

`auto` preserves current journal detection; `push` always calls `provisionSchema(internals.db, internals.schema, { force: true, databaseUrl: internals.databaseUrl })`; `migrations` requires the journal and calls `internals.adapter.migrate(internals.db, internals.migrationsFolder)`, otherwise throws `committed migrations journal not found`.

- [ ] **Step 6: Implement the base fixture with ordered cleanup**

Define:

```ts
export type TestOptions = {
  env?: Record<string, string | undefined>
  database?: {
    mode?: 'memory' | 'temporary'
    schema?: 'auto' | 'push' | 'migrations'
    strategy?: TestDatabaseStrategy
  }
}

export type TestFixture<TApp> = AsyncDisposable & {
  readonly app: TApp
  close(): Promise<void>
}
```

Merge `TestOptions.env` only with `{ NODE_ENV: 'test', AUTH_SECRET: 'bunderstack-test-secret', BUNDERSTACK_ROLE: 'web' }`. Allocate target, call `BACKEND_INTERNALS.start()` with its connection and `backgroundAutoStart: false`, provision, then return a close-once fixture. On setup failure close app if created, dispose the target, and aggregate dual failures.

- [ ] **Step 7: Run fixture and adapter suites**

Run: `bun test packages/bunderstack/src/testing/fixture.test.ts packages/bunderstack/src/db.test.ts packages/bunderstack/src/database`

Expected: PASS for libSQL/PGlite isolation and external-adapter refusal.

- [ ] **Step 8: Commit the fixture foundation**

```bash
git add packages/bunderstack/src/testing.ts packages/bunderstack/src/testing packages/bunderstack/src/database packages/bunderstack/src/db.ts packages/bunderstack/src/provision.ts
git commit -m "feat: add isolated bunderstack test fixtures"
```

---

### Task 4: Substitute and expose email, storage, and realtime test infrastructure

**Files:**
- Create: `packages/bunderstack/src/testing/email.ts`
- Create: `packages/bunderstack/src/testing/storage.ts`
- Create: `packages/bunderstack/src/testing/infrastructure.test.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/email.ts:23-230`
- Modify: `packages/bunderstack/src/storage/buckets.ts:46-307`
- Modify: `packages/bunderstack/src/storage/registry.ts:12-40`

**Interfaces:**
- Extends `TestFixture` with `email.sent` and `storage.read(key)`.
- Consumes `RuntimeOverrides.emailAdapter`, `resolvedStorage`, and `forceMemoryRealtime` from Task 1.
- Preserves production bucket names, visibility, policies, quotas, and transforms.

- [ ] **Step 1: Add failing infrastructure substitution tests**

Declare a backend with Resend, S3, Redis realtime, and one private bucket. Start a fixture without their credentials and assert:

```ts
await t.app.email.send({ to: 'a@test', subject: 'Hello', text: 'Body' })
expect(t.email.sent).toEqual([
  expect.objectContaining({ to: ['a@test'], subject: 'Hello', text: 'Body' }),
])
await t.app.storage.upload('files/a.txt', bytes, 'text/plain')
expect(await t.storage.read('files/a.txt')).toEqual(bytes)
expect(t.app.realtime.transport).toBe('memory')
```

Assert no fetch, S3, or Redis constructor is invoked and two fixtures cannot see each other's stored object.

- [ ] **Step 2: Run the test and verify production adapters are still selected**

Run: `bun test packages/bunderstack/src/testing/infrastructure.test.ts`

Expected: FAIL on missing credentials or external adapter construction.

- [ ] **Step 3: Add an injectable email adapter and capture implementation**

Let `createEmail()` accept an internal `adapterOverride`. Implement `createTestEmail()` returning `{ adapter, sent }`; normalize `to`, `cc`, and `bcc` arrays and clone each final resolved message before returning `{ id: 'test-email-N' }`. The production provider resolver remains unchanged, including the managed-host override.

- [ ] **Step 4: Resolve all test buckets onto one fixture-local root**

Implement `resolveTestBuckets(input, root)` by first resolving logical bucket metadata against `{}`, then replacing every `ResolvedBucket.backend` with `{ type: 'local', path: root }`. Reuse the normal registry and operations so policy and metadata behavior stay real. `TestStorage.read(key)` calls the selected adapter's `get()`, throws on non-200, and returns `Uint8Array`.

- [ ] **Step 5: Force memory realtime only through internal overrides**

In `materializeRuntime`, ignore resolved Redis URL only when `forceMemoryRealtime === true`; retain buffer and resume settings. Do not expose this switch on `StartOptions` or `TestOptions`.

- [ ] **Step 6: Wire substitutions and cleanup into the fixture**

Allocate one storage tmpdir per fixture, pass capture adapter/test buckets/memory realtime into `BACKEND_INTERNALS.start()`, and delete the storage root after `app.close()`. Expose frozen observation arrays so tests cannot mutate framework capture state.

- [ ] **Step 7: Run infrastructure and existing email/storage tests**

Run: `bun test packages/bunderstack/src/testing/infrastructure.test.ts packages/bunderstack/src/email.test.ts packages/bunderstack/src/storage`

Expected: PASS; production email/storage behavior remains unchanged.

- [ ] **Step 8: Commit infrastructure substitutions**

```bash
git add packages/bunderstack/src/testing packages/bunderstack/src/runtime.ts packages/bunderstack/src/email.ts packages/bunderstack/src/storage
git commit -m "feat: isolate test email storage and realtime"
```

---

### Task 5: Add real auth identities and the typed in-process client

**Files:**
- Create: `packages/bunderstack/src/testing/auth.ts`
- Create: `packages/bunderstack/src/testing/client.ts`
- Create: `packages/bunderstack/src/testing/auth-client.test.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Modify: `packages/bunderstack/src/testing.ts`
- Modify: `packages/bunderstack/src/client/rpc-client.ts:9-135`

**Interfaces:**
- Produces: `TestIdentity = { user; headers }`.
- Produces: `TestAuth.signUpEmail()` and `TestAuth.mockSession()`.
- Produces: `TestFixture.client(identity?): BunderstackClient<TApp>`.
- Produces: `TestAuthError` with `status` and `body`.

- [ ] **Step 1: Add failing real-sign-up and typed-client tests**

Use a backend with email/password enabled and a `user.create` database hook. Assert sign-up through `t.auth.signUpEmail()` inserts the hook row, returned headers authenticate `t.client(alice)`, and an invalid sign-up throws `TestAuthError` with status/body. Add compile-time assertions that valid procedures exist and unknown procedures are rejected with `@ts-expect-error`.

- [ ] **Step 2: Run the test and confirm auth/client fixture capabilities are missing**

Run: `bun test packages/bunderstack/src/testing/auth-client.test.ts`

Expected: FAIL because `t.auth` and `t.client` do not exist.

- [ ] **Step 3: Implement HTTP email sign-up and cookie extraction**

POST JSON to `http://bunderstack.test/api/auth/sign-up/email` through `app.handler`. Default password to `password-123`; preserve caller name/password. Collect every `Set-Cookie`, retain only each `name=value`, join with `; `, and return it in a new `Headers({ cookie })`. Parse the returned user into the exact `TestIdentity.user` fields.

- [ ] **Step 4: Implement mock identities without organization assumptions**

Move the root `mockAuthSession` export under `bunderstack/testing`. `t.auth.mockSession(user)` calls it and returns `{ user, headers: new Headers() }`. Do not call Better Auth organization plugin methods or return an organization ID.

- [ ] **Step 5: Build the client over app.handler**

Implement:

```ts
export function testClient<TApp extends AnyBunderstackApp>(
  app: TApp,
  identity?: TestIdentity,
): BunderstackClient<TApp> {
  return createClient<TApp>({
    baseUrl: 'http://bunderstack.test/api',
    fetch: (input, init) => app.handler(new Request(input, init)),
    headers: identity?.headers,
  })
}
```

Reuse the current `$inferClient` carrier; do not introduce router casts.

- [ ] **Step 6: Run auth, client, and declaration-emission tests**

Run: `bun test packages/bunderstack/src/testing/auth-client.test.ts packages/bunderstack/src/client/rpc-client.test.ts && bun run --cwd packages/bunderstack typecheck`

Expected: PASS, including negative compile-time assertions.

- [ ] **Step 7: Commit auth and typed clients**

```bash
git add packages/bunderstack/src/testing packages/bunderstack/src/testing.ts packages/bunderstack/src/client/rpc-client.ts
git commit -m "feat: add test auth identities and typed clients"
```

---

### Task 6: Add deterministic `runNext` and `runUntilIdle`

**Files:**
- Create: `packages/bunderstack/src/testing/jobs.ts`
- Create: `packages/bunderstack/src/testing/jobs.test.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Modify: `packages/bunderstack/src/backend-internals.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/jobs/worker.ts:355-368`

**Interfaces:**
- Produces: `JobRunReport = { ticks; claimed; ran; failed; remainingRunnable }`.
- Produces: `TestJobs.runNext({ now? })` and `runUntilIdle({ now?, maxTicks?, failOnJobError? })`.
- Produces: `TestJobsError` and `TestJobsConvergenceError`.

- [ ] **Step 1: Add failing deterministic queue tests**

Cover immediate work, recursively enqueued work, a delayed job at two explicit times, retry scheduled beyond fixed `now`, terminal failure details, and a handler that enqueues itself until the default/explicit tick limit. Use no `setTimeout` or polling loop.

- [ ] **Step 2: Run the test and verify fixture jobs are missing**

Run: `bun test packages/bunderstack/src/testing/jobs.test.ts`

Expected: FAIL because `t.jobs.runUntilIdle` does not exist.

- [ ] **Step 3: Expose a private queue inspection handle**

Add only to `BACKEND_INTERNALS`/fixture materialization:

```ts
export type RuntimeTestingHandle = {
  tick(now: number): Promise<TickResult>
  inspect(now: number): Promise<{
    runnable: number
    failed: Array<{
      id: string
      name: string
      attempts: number
      lastError: string | null
    }>
  }>
}
```

Implement inspection against the dialect-specific internal jobs table. Strip the cron prefix when reporting a name. Do not add inspection to production `app.jobs`.

- [ ] **Step 4: Implement fixed-clock runners**

`runNext` invokes one tick and then inspects. `runUntilIdle` fixes `now` once, loops until `runnable === 0`, aggregates results, throws `TestJobsError` for terminal failures by default, and throws `TestJobsConvergenceError` after `maxTicks ?? 100`. It never advances time or waits.

- [ ] **Step 5: Run fixture jobs and existing worker suites**

Run: `bun test packages/bunderstack/src/testing/jobs.test.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/integration.test.ts`

Expected: PASS without timing sleeps in the new fixture tests.

- [ ] **Step 6: Commit deterministic job helpers**

```bash
git add packages/bunderstack/src/testing packages/bunderstack/src/backend-internals.ts packages/bunderstack/src/runtime.ts packages/bunderstack/src/jobs/worker.ts
git commit -m "feat: add deterministic test job runners"
```

---

### Task 7: Publish and prove the testing boundary

**Files:**
- Modify: `packages/bunderstack/package.json:38-155`
- Modify: `packages/bunderstack/src/testing.ts`
- Modify: `scripts/bundle-boundaries.test.ts`
- Modify: `scripts/dependency-boundaries.test.ts:91-107`
- Modify: `scripts/verify-consumer.ts:203-280`
- Test: `scripts/packaging-contract.test.ts`

**Interfaces:**
- Produces public subpath: `bunderstack/testing` -> `dist/testing.js`/`.d.ts`.
- Exports fixture types/helpers, database strategy types, errors, and `mockAuthSession` only from that subpath.
- Proves root import does not eagerly load testing implementation or `bun:test`.

- [ ] **Step 1: Add failing export and bundle-boundary assertions**

Assert package exports contain `./testing`; root bundle text excludes `testing/fixture`, `node:fs`, `node:os`, and `bun:test`; a bundle with `import 'bunderstack/testing'` includes fixture code but still excludes `bun:test`.

- [ ] **Step 2: Add testing export and explicit public surface**

Export `createTestApp`, `TestFixture`, `TestOptions`, `TestIdentity`, `TestAuthError`, job errors/reports, database strategy types, and `mockAuthSession` from `testing.ts`. Add the package export mapping. Do not wildcard-export private backend/runtime handles.

- [ ] **Step 3: Update the strict consumer probe**

Generate a consumer with:

```ts
export const backend = bunderstack({
  schema,
  database: { adapter: libsql() },
  api,
})
export type App = Awaited<ReturnType<typeof backend.start>>
```

Add a non-executed type probe importing `TestFixture` from `bunderstack/testing`. Keep `skipLibCheck: false` and the existing client inference checks.

- [ ] **Step 4: Build and verify boundaries**

Run: `bun run build && bun test scripts/bundle-boundaries.test.ts scripts/dependency-boundaries.test.ts scripts/packaging-contract.test.ts && bun run verify:consumer`

Expected: PASS; emitted testing entry resolves and root production bundle has no eager fixture code.

- [ ] **Step 5: Commit the published testing contract**

```bash
git add packages/bunderstack/package.json packages/bunderstack/src/testing.ts scripts/bundle-boundaries.test.ts scripts/dependency-boundaries.test.ts scripts/verify-consumer.ts scripts/packaging-contract.test.ts
git commit -m "feat: publish bunderstack testing fixtures"
```

---

### Task 8: Migrate the framework suite and remove `createBunderstack`

**Files:**
- Modify: `packages/bunderstack/src/access.integration.test.ts`
- Modify: `packages/bunderstack/src/api/error-status.integration.test.ts`
- Modify: `packages/bunderstack/src/api/global-middleware.test.ts`
- Modify: `packages/bunderstack/src/api/list-contract.integration.test.ts`
- Modify: `packages/bunderstack/src/api/openapi-client-generation.test.ts`
- Modify: `packages/bunderstack/src/api/openapi.test.ts`
- Modify: `packages/bunderstack/src/api/router.test.ts`
- Modify: `packages/bunderstack/src/app-env.test.ts`
- Modify: `packages/bunderstack/src/auth-context.test.ts`
- Modify: `packages/bunderstack/src/auth-email.test.ts`
- Modify: `packages/bunderstack/src/bunsql.integration.test.ts`
- Modify: `packages/bunderstack/src/client/rpc-client.test.ts`
- Modify: `packages/bunderstack/src/codegen.test.ts`
- Modify: `packages/bunderstack/src/config-env-inference.test.ts`
- Modify: `packages/bunderstack/src/config.test.ts`
- Modify: `packages/bunderstack/src/handler.test.ts`
- Modify: `packages/bunderstack/src/infer-client.test.ts`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`
- Modify: `packages/bunderstack/src/provision.integration.test.ts`
- Modify: `packages/bunderstack/src/provision.pg.integration.test.ts`
- Modify: `packages/bunderstack/src/realtime/app-publish.test.ts`
- Modify: `packages/bunderstack/src/realtime/table-naming.integration.test.ts`
- Modify: `packages/bunderstack/src/storage/multibucket.integration.test.ts`
- Modify: `packages/bunderstack/src/api/api-types.types.ts`
- Modify: `packages/bunderstack/src/api/list-input.types.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**
- Consumes the complete backend/fixture surface from Tasks 1-7.
- Removes the temporary `createBunderstack`/`LegacyBunderstackConfig` shim.
- Moves manifest assertions from runtime apps to backend declarations.

- [ ] **Step 1: Mechanically migrate runtime-only tests**

For tests of production startup/lifecycle, replace:

```ts
const app = await createBunderstack({
  schema,
  database: { adapter: libsql() },
  processEnv,
})
```

with:

```ts
const backend = bunderstack(config)
const app = await backend.start({ env: processEnv })
```

Keep explicit `app.close()` where the test is specifically asserting production lifecycle.

- [ ] **Step 2: Migrate ordinary integration tests to lexical fixtures**

Replace direct construction/provision/cleanup with:

```ts
const backend = bunderstack(config)
await using t = await backend.test({ env: testEnv })
const { app } = t
```

Delete corresponding `provision(app, { force: true })`, app arrays, `afterEach`, and `finally { await app.close() }`. Use `database.schema: 'migrations'` only in tests whose subject is committed migrations.

- [ ] **Step 3: Move declaration metadata tests off runtimes**

Replace `app.manifest` with `backend.manifest`. Delete introspection-mode tests and replace them with assertions that constructing the backend does not connect or require env.

- [ ] **Step 4: Update type-only test sources**

Use `const backend = bunderstack(config)`, `type App = Awaited<ReturnType<typeof backend.start>>`, and preserve every existing `@ts-expect-error` negative assertion for routes, job payloads, env, and clients.

- [ ] **Step 5: Remove the compatibility shim and stale wording**

Delete `createBunderstack`, `LegacyBunderstackConfig`, `processEnv` from public config, runtime `app.manifest`, and stale comments/error messages in `email.ts`, `env.ts`, `provision-internals.ts`, `query/infer.ts`, `jobs/index.ts`, and API builder comments.

- [ ] **Step 6: Prove the old API and global introspection are gone**

Run:

```bash
rg 'createBunderstack|BUNDERSTACK_INTROSPECT|processEnv' packages/bunderstack/src
```

Expected: no matches except historical changelog/spec/plan text outside `src`.

- [ ] **Step 7: Run the full package suite**

Run: `bun run --cwd packages/bunderstack typecheck && bun run --cwd packages/bunderstack test`

Expected: PASS, including PostgreSQL tests when their existing opt-in environment is available; otherwise the same documented skips as baseline.

- [ ] **Step 8: Commit the clean API break**

```bash
git add packages/bunderstack/src
git commit -m "refactor: migrate core to bunderstack declarations"
```

---

### Task 9: Migrate the SaaS template, examples, docs, and generated contracts

**Files:**
- Create: `templates/tanstack-start-saas/src/bunderstack/backend.ts`
- Modify: `templates/tanstack-start-saas/src/bunderstack/index.ts`
- Modify: `templates/tanstack-start-saas/src/bunderstack/app.test.ts`
- Modify: `templates/tanstack-start-saas/package.json`
- Modify: `templates/tanstack-start-saas/bunderstack.blueprint.yaml`
- Modify: `templates/tanstack-start-saas/README.md`
- Modify: `scripts/template-contract.test.ts`
- Modify: `scripts/llms-contract.test.ts`
- Modify: `scripts/website-contract.test.ts`
- Modify: `website/scripts/gen-code-snippets.ts`
- Modify: `packages/bunderstack/README.md`
- Modify: `packages/bunderstack/llms.txt`
- Modify: `examples/README.md`
- Modify: `.agents/skills/creating-bunderstack-apps/references/application-structure.md`
- Modify: `.agents/skills/migrating-to-bunderstack/SKILL.md`
- Modify: `.agents/skills/migrating-to-bunderstack/references/audit-checklist.md`
- Modify: `.agents/skills/migrating-to-bunderstack/references/runtime-replacements.md`
- Modify: `examples/agent-chat/src/bunderstack.ts`
- Modify: `examples/agent-chat/src/test-app.ts`
- Modify: `examples/kanban-solid-1.9/src/bunderstack.ts`
- Modify: `examples/kanban-tanstack/src/bunderstack.ts`
- Modify: `examples/tldraw/src/bunderstack.ts`
- Modify: `examples/todo-solid-2/src/bunderstack.ts`
- Modify: `examples/todo-solid-native/src/bunderstack.ts`
- Modify: `examples/todo/src/api.ts`
- Modify: `examples/todo/src/bunderstack.ts`
- Modify: `examples/twitter-db-tanstack/scripts/seed.ts`
- Modify: `examples/twitter-db-tanstack/src/bunderstack.ts`
- Modify: `examples/twitter-tanstack/scripts/seed.ts`
- Modify: `examples/twitter-tanstack/src/bunderstack.ts`
- Modify: `templates/tanstack-start-saas/src/bunderstack/api.ts`
- Modify: `templates/tanstack-start-saas/src/bunderstack/auth.ts`

**Interfaces:**
- Produces the reference declaration at `src/bunderstack/backend.ts` and runtime singleton at `src/bunderstack/index.ts`.
- Changes template `package.json#bunderstack.entry` to `src/bunderstack/backend.ts`.
- Demonstrates `await using t = await backend.test()` as the default test pattern.

- [ ] **Step 1: Make template contract tests demand declaration/startup separation**

Assert the entry is `src/bunderstack/backend.ts`, both backend/index files exist, backend source contains `bunderstack({` and no `.start()`, and index source contains `backend.start()`.

- [ ] **Step 2: Split the template and migrate its tests**

Move the static config to `backend.ts`:

```ts
export const backend = bunderstack({
  schema,
  access,
  env: envSchema,
  database: { adapter: libsql() },
  auth: authConfig,
  email: { from: 'BunderSaaS <hello@example.com>' },
  storage,
  realtime: true,
  jobs: defineJobs,
  middleware: [requestTiming],
  api,
})
```

In `index.ts`, export `app = await backend.start()`, app members, and runtime type. Replace template app arrays/session stubs with lexical fixtures and `t.auth`/`t.client`; assert metadata on `backend.manifest`.

- [ ] **Step 3: Regenerate and check the committed Blueprint**

Run: `bun run --cwd templates/tanstack-start-saas blueprint && bun run --cwd templates/tanstack-start-saas blueprint:check`

Expected: PASS; YAML shape/version stay unchanged except `bunderstack.entry` and generator version if the package version changes later.

- [ ] **Step 4: Migrate examples and published prose**

For executable examples, export a backend plus a started app where required. For code snippets, teach the declaration/start distinction and replace “createBunderstack” terminology. Update the creating/migrating agent skills so generated apps use `bunderstack()` and lexical fixtures.

- [ ] **Step 5: Prove no live source teaches the removed API**

Run:

```bash
rg 'createBunderstack' packages examples templates website scripts .agents/skills --glob '!**/docs/**'
```

Expected: no matches.

- [ ] **Step 6: Run template, example, website, and contract checks**

Run: `bun test scripts/template-contract.test.ts scripts/llms-contract.test.ts scripts/website-contract.test.ts && bun run typecheck:examples && bun test templates/tanstack-start-saas/src/bunderstack/app.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit consumer migrations**

```bash
git add templates examples website scripts .agents/skills packages/bunderstack/README.md packages/bunderstack/llms.txt
git commit -m "docs: migrate consumers to bunderstack declarations"
```

---

### Task 10: Final release verification and bunderhost handoff

**Files:**
- Modify: `packages/bunderstack/package.json:1-4`
- Modify: `CHANGELOG.md`
- Test: all workspace packages and scripts

**Interfaces:**
- Produces a publishable beta package containing the declaration/testing contract.
- Produces the exact version consumed by the companion bunderhost migration plan.

- [ ] **Step 1: Add the release note and beta version**

Set the next unused beta version after the current package version consistently with repository release policy. In `CHANGELOG.md`, document the intentional `createBunderstack` removal, `bunderstack()`/`.start()` migration, pure Blueprint backend export, and `backend.test()` fixture.

- [ ] **Step 2: Run formatting and inspect its diff**

Run: `bun run fix && git diff --check`

Expected: formatter/linter succeed; inspect and retain only task-related formatting.

- [ ] **Step 3: Run complete verification**

Run:

```bash
bun run typecheck:all
bun test
bun run build
bun run verify:consumer
bun run test:boundaries
bun run test:bundles
bun run --cwd templates/tanstack-start-saas blueprint:check
```

Expected: every command exits 0.

- [ ] **Step 4: Audit the final public contract**

Run:

```bash
rg 'createBunderstack|BUNDERSTACK_INTROSPECT' packages/bunderstack/src packages/bunderstack/dist
rg '"./testing"' packages/bunderstack/package.json
git status --short
```

Expected: first command has no matches; testing export exists; status contains only intended release files.

- [ ] **Step 5: Commit the release-ready framework**

```bash
git add packages/bunderstack/package.json CHANGELOG.md
git commit -m "chore: prepare declarative runtime beta"
```

- [ ] **Step 6: Continue with the dependent consumer plan**

Execute `docs/superpowers/plans/2026-08-27-declarative-runtime-testing-bunderhost.md` only after the bunderhost layout refactor is committed and the new Bunderstack package version is installable or supplied as an explicit local tarball.
