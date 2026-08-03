# Static Dependency Boundaries Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `static-dependency-boundaries` to a mergeable state by fixing database lifecycle and introspection regressions, correcting peer metadata, enforcing bundle boundaries, updating public documentation, and removing unrelated changes from the branch.

**Architecture:** Preserve the explicit adapter and package-subpath design already introduced by the branch. Extend the database adapter contract with an explicit connection result (`db` plus optional cleanup) and an explicit introspection flag; every built-in adapter uses `drizzle.mock()` during introspection, so introspection performs no network or filesystem I/O. Reconstruct the repair branch from the four focused commits before `650541d`, then reapply only reviewed changes so formatting churn, generated files, migrations, and unrelated example work never enter the final diff.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PGlite, libSQL, Bun SQL, postgres.js, Better Auth, Hono, Bun.build, Bun test.

## Global Constraints

- Use Bun for installation, scripts, tests, and builds; do not introduce Node-, npm-, pnpm-, Vite-, Jest-, or Vitest-based commands.
- Keep source TypeScript as the published artifact; keep `typescript` as an optional peer with range `>=5`.
- Keep `better-auth` a required peer of `bunderstack` because the root entrypoint imports it statically.
- Keep database drivers and `nodemailer` optional peers exposed only through their documented subpaths.
- Set the `nodemailer` peer range to `>=6 <10`; do not leave an empty peer range.
- Do not introduce variable dynamic imports. Every optional integration must be selected through a statically analyzable package subpath.
- Introspection must not connect to a database, create a database directory, contact Redis, or require a valid production database URL.
- `app.close()` must close the database connection created by its selected adapter.
- Published source under `packages/*/src` must not contain `@ts-nocheck`.
- Do not retain changes to historical plans/specs, generated route trees, migration snapshots, generated website JSON, or unrelated example UI code.
- Do not modify or force-reset the existing `static-dependency-boundaries` worktree. Build the repaired result on a new branch/worktree so the reviewed branch remains recoverable.

---

## Target file map

**Database contract and runtime**

- `packages/bunderstack/src/database/adapter.ts`: owns `DatabaseConnectOptions`, `DatabaseConnectionResult`, and `DatabaseAdapter`.
- `packages/bunderstack/src/database/{libsql,pglite,bun-sql,postgres-js}.ts`: construct real or mock Drizzle clients and expose connection cleanup.
- `packages/bunderstack/src/db.ts`: validates adapter/dialect/URL and returns the adapter connection result.
- `packages/bunderstack/src/index.ts`: passes introspection mode into `createDb` and registers database cleanup with `Lifecycle`.

**Dependency boundaries**

- `packages/bunderstack/package.json`: required/optional peer metadata.
- `packages/bunderstack-query/src/client.ts`: type-only React Query import.
- `scripts/dependency-boundaries.test.ts`: source, export, peer, and forbidden-import assertions.
- `scripts/bundle-boundaries.test.ts`: actual browser-bundle smoke tests and size ceilings.
- `package.json`: exposes `test:bundles` and includes it in the relevant verification path.

**Public contract and examples**

- `README.md`, `packages/bunderstack/README.md`, `docs/dependency-model.md`: canonical dependency and quick-start documentation.
- `website/content/docs/{getting-started,configuration,api-reference}.mdx`: website equivalents.
- `examples/*/src/bunderstack.ts`, `examples/*/src/**/*auth-client.ts`, `examples/*/src/**/*api-client.ts`: only import/config migrations required by the new subpaths.

---

### Task 1: Reconstruct a clean repair branch and restore the typecheck baseline

**Files:**

- Modify: `packages/bunderstack/src/realtime/facade.test.ts`
- Modify: `packages/bunderstack/src/auth.ts`
- Modify: `packages/bunderstack-start/src/isomorphic-fetch.ts`
- Reference only: branch `static-dependency-boundaries`, commits `9f1287d`, `714a81c`, `57a78cc`, `26f2ec1`, `650541d`

**Interfaces:**

- Consumes: the four focused commits preceding `650541d`.
- Produces: a clean `codex/static-dependency-boundaries-fixes` branch with the query/start/manifest boundary work and a green package typecheck before database fixes are reapplied.

- [ ] **Step 1: Create an isolated repair worktree from `main`**

Use the `superpowers:using-git-worktrees` skill. Create branch `codex/static-dependency-boundaries-fixes` from `main`; do not switch or reset the existing worktree.

Run:

```bash
git worktree add .worktrees/static-dependency-boundaries-fixes -b codex/static-dependency-boundaries-fixes main
```

Expected: a new clean worktree whose `git status --short` is empty.

- [ ] **Step 2: Reapply only the four focused commits**

Run in the new worktree:

```bash
git cherry-pick 9f1287d 714a81c 57a78cc 26f2ec1
```

Expected: four commits apply without including the 235-file final commit. If a manifest conflict occurs because `main` advanced, preserve the new subpath exports and the peer/development dependency separation from the picked commits.

- [ ] **Step 3: Add regression assertions against published `@ts-nocheck` directives**

Append this test to `scripts/dependency-boundaries.test.ts`:

```ts
test('published package source does not disable TypeScript checking', async () => {
  const glob = new Bun.Glob('packages/*/src/**/*.{ts,tsx}')
  const offenders: string[] = []

  for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    const source = await Bun.file(join(repoRoot, path)).text()
    if (source.includes('@ts-nocheck')) offenders.push(path)
  }

  expect(offenders).toEqual([])
})
```

Use the file's existing `repoRoot` and `join` helpers; do not create duplicate helpers.

- [ ] **Step 4: Run the new guard and verify the selected source from `650541d` would fail it**

Run:

```bash
git show 650541d:packages/bunderstack/src/auth.ts | rg '@ts-nocheck'
git show 650541d:packages/bunderstack-start/src/isomorphic-fetch.ts | rg '@ts-nocheck'
bun test scripts/dependency-boundaries.test.ts -t "published package source"
```

Expected: both `git show` commands print an `@ts-nocheck` line; the scoped current-branch test passes because those directives were not cherry-picked. The full boundary file still has expected RED assertions for the not-yet-migrated SMTP implementation; Task 6 makes those green.

- [ ] **Step 5: Make the realtime type-error assertions formatter-stable**

Restore only the realtime facade test, then replace its fragile assertion with two independent calls:

```bash
git restore --source=650541d -- packages/bunderstack/src/realtime/facade.test.ts
```

Use:

```ts
// @ts-expect-error — title is required for a board create payload
void realtime.publish(boards, 'create', { id: 'b1' })

void realtime.publish(boards, 'create', {
  id: 'b1',
  title: 'Board',
  // @ts-expect-error — email is not a column in the boards table
  email: 'owner@example.com',
})
```

This avoids placing `@ts-expect-error` above a multi-line object expression whose diagnostic is attached to a property.

- [ ] **Step 6: Run the typecheck baseline**

The query-entrypoint commit contains the consumer half of the later provisioning-adapter change. Restore `provision.ts` until Task 2 brings in the complete adapter contract atomically:

```bash
git restore --source=main -- packages/bunderstack/src/provision.ts
```

In `packages/bunderstack-query/tests/trpc-client.test.ts`, keep the moved test and its new query entrypoint, but postpone the `bunderstack/database/libsql` import and `database.adapter` config until Task 2 restores that public subpath. At this checkpoint the test continues to use `database: { url: ':memory:' }`.

Run:

```bash
bun run typecheck
```

Expected: all four package TypeScript projects exit 0 with no unused `@ts-expect-error` and no suppressed published file.

- [ ] **Step 7: Commit the baseline guard**

```bash
git add scripts/dependency-boundaries.test.ts packages/bunderstack/src/realtime/facade.test.ts
git commit -m "test: guard published TypeScript sources"
```

Expected: the commit contains only the guard and the formatter-stable type test.

---

### Task 2: Make database ownership and cleanup explicit

**Files:**

- Modify: `packages/bunderstack/src/database/adapter.ts`
- Modify: `packages/bunderstack/src/database/libsql.ts`
- Modify: `packages/bunderstack/src/database/pglite.ts`
- Modify: `packages/bunderstack/src/database/bun-sql.ts`
- Modify: `packages/bunderstack/src/database/postgres-js.ts`
- Modify: `packages/bunderstack/src/db.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/provision.ts`
- Modify: `packages/bunderstack/src/provision-internals.ts`
- Test: `packages/bunderstack/src/database/adapter.test.ts`
- Test: `packages/bunderstack/src/db.test.ts`
- Test: `packages/bunderstack/src/db.pg.test.ts`
- Test: `packages/bunderstack/src/app-env.test.ts`
- Test: package test call sites under `packages/bunderstack/src/**/*.test.ts` that construct `createBunderstack` with the now-required database adapter

**Interfaces:**

- Consumes: `DbFor<TSchema>`, `Driver`, `Dialect`, and `Lifecycle.add(() => void | Promise<void>)`.
- Produces:

```ts
export type DatabaseConnectOptions = { introspect: boolean }

export type DatabaseConnectionResult<TSchema extends Record<string, unknown>> =
  {
    db: DbFor<TSchema>
    close?: () => void | Promise<void>
  }

export type DatabaseAdapter = {
  readonly dialect: Dialect
  readonly driver: Driver
  connect<TSchema extends Record<string, unknown>>(
    schema: TSchema,
    connection: DatabaseConnection,
    options: DatabaseConnectOptions,
  ): Promise<DatabaseConnectionResult<TSchema>>
  migrate(db: AnyDb, migrationsFolder: string): Promise<void>
}
```

- [ ] **Step 1: Restore only the explicit-adapter core from the reviewed commit**

Run:

```bash
git restore --source=650541d -- packages/bunderstack/src/database packages/bunderstack/src/db.ts packages/bunderstack/src/db.test.ts packages/bunderstack/src/db.pg.test.ts packages/bunderstack/src/config.ts packages/bunderstack/src/config.test.ts packages/bunderstack/src/index.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/provision.ts packages/bunderstack/src/provision.test.ts packages/bunderstack/src/provision-internals.ts
```

Expected: the explicit adapter contract, built-in adapters, required config, and their focused tests are present. Do not restore the entire package source tree. Immediately remove any `@ts-nocheck` if one appears in this exact set; the boundary test from Task 1 must remain green.

- [ ] **Step 2: Write a failing `createDb` ownership test**

In `packages/bunderstack/src/db.test.ts`, add an adapter whose `connect` returns a known `close` spy and assert the result preserves it:

```ts
test('createDb returns the adapter cleanup', async () => {
  let closed = false
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      return {
        db: drizzle.mock({ schema }),
        close: () => {
          closed = true
        },
      } as never
    },
    async migrate() {},
  }

  const connection = await createDb(schema, {
    adapter,
    dialect: 'sqlite',
    url: ':memory:',
    introspect: false,
  })
  await connection.close?.()
  expect(closed).toBe(true)
})
```

Import `DatabaseAdapter` as a type and use the existing sqlite schema/Drizzle test helpers in that file.

- [ ] **Step 3: Run the ownership test and verify it fails**

Run:

```bash
bun test --cwd packages/bunderstack src/db.test.ts -t "createDb returns the adapter cleanup"
```

Expected: FAIL because the current adapter returns only a database and `createDb` has no `close` property.

- [ ] **Step 4: Change the adapter and `createDb` contracts**

Implement the interfaces shown above in `database/adapter.ts`. Change `createDb` to accept `introspect?: boolean`, default it to `false`, and return the connection result plus the driver:

```ts
export async function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: DatabaseConnection & {
    adapter: DatabaseAdapter
    dialect: Dialect
    introspect?: boolean
  },
): Promise<DatabaseConnectionResult<TSchema> & { driver: Driver }> {
  if (cfg.adapter.dialect !== cfg.dialect) {
    throw new Error(
      `[bunderstack] database adapter dialect ${cfg.adapter.dialect} does not match ${cfg.dialect} schema`,
    )
  }
  if (!cfg.introspect) validateDatabaseUrl(cfg.url, cfg.dialect)
  const result = await cfg.adapter.connect(
    schema,
    { url: cfg.url, authToken: cfg.authToken },
    { introspect: cfg.introspect ?? false },
  )
  return { ...result, driver: cfg.adapter.driver }
}
```

- [ ] **Step 5: Return real cleanup functions from all four adapters**

Use the driver's public client handle:

```ts
// pglite.ts
const db = drizzle(dataDir, { schema })
return { db: db as never, close: () => db.$client.close() }

// libsql.ts
const db = drizzle({ connection, schema })
return { db: db as never, close: () => db.$client.close() }

// postgres-js.ts
const db = drizzle(url, { schema })
return { db: db as never, close: () => db.$client.end() }

// bun-sql.ts
const db = drizzle(url, { schema })
return { db: db as never, close: () => db.$client.close() }
```

If Bun SQL's installed type exposes `close()` as synchronous, keep the wrapper synchronous; `Lifecycle` accepts both forms.

- [ ] **Step 6: Register database cleanup before broker cleanup**

In `createBunderstack`, create `Lifecycle` before `createDb`, destructure `close`, and register it immediately:

```ts
const lifecycle = new Lifecycle()
const {
  db,
  driver,
  close: closeDatabase,
} = await createDb(mergedSchema, {
  ...config.database,
  dialect,
  introspect,
})
if (closeDatabase) lifecycle.add(closeDatabase)
```

Remove the later duplicate `const lifecycle = new Lifecycle()`. Keep broker registration where it currently occurs. Because lifecycle cleanups run in reverse registration order, broker cleanup may run before database cleanup.

- [ ] **Step 7: Add an application-level cleanup test**

In `app-env.test.ts`, use a fake sqlite adapter returning `drizzle.mock()` and a cleanup spy. Create the app, call `await app.close()`, and assert cleanup ran exactly once. Call `await app.close()` a second time and assert the count remains one, matching `Lifecycle.close()` idempotency.

- [ ] **Step 8: Update PGlite filesystem tests to close before removing their directory**

In every `db.pg.test.ts` test that uses a `file:<nested/dir>` URL, retain the `close` returned by `createDb` and use `try/finally`:

```ts
const { db, close } = await createDb(schema, config)
try {
  // existing assertions
} finally {
  await close?.()
  await rm(databaseDirectory, { recursive: true, force: true })
}
```

The order is mandatory: close first, remove second.

- [ ] **Step 8a: Migrate package test call sites atomically**

Run `bun run typecheck`, collect every package test call site that fails because `database.adapter` is now required, and update only those object literals. SQLite tests import and use `libsql()`; pg tests import and use `pglite()`. Do not restore whole test files from `650541d`, because that reintroduces unrelated formatting churn. Repeat `bun run typecheck` until it exits 0 before committing Task 2.

- [ ] **Step 9: Verify the isolated PGlite regression and lifecycle tests**

Run:

```bash
bun test --cwd packages/bunderstack src/db.pg.test.ts -t "file:<nested/dir>"
bun test --cwd packages/bunderstack src/db.test.ts src/app-env.test.ts
```

Expected: assertions pass and both Bun commands exit 0, not exit 99.

- [ ] **Step 10: Commit database lifecycle ownership**

```bash
git add packages/bunderstack/src/database packages/bunderstack/src/db.ts packages/bunderstack/src/db.test.ts packages/bunderstack/src/db.pg.test.ts packages/bunderstack/src/index.ts packages/bunderstack/src/app-env.test.ts packages/bunderstack/src/config.ts packages/bunderstack/src/config.test.ts packages/bunderstack/src/provision.ts packages/bunderstack/src/provision.test.ts packages/bunderstack/src/provision-internals.ts
git commit -m "fix: close database adapter connections"
```

Also stage every package test file changed by Step 8a; verify the staged diff contains only adapter imports/config entries in those additional tests.

---

### Task 3: Make introspection adapter-neutral and offline

**Files:**

- Modify: `packages/bunderstack/src/database/libsql.ts`
- Modify: `packages/bunderstack/src/database/pglite.ts`
- Modify: `packages/bunderstack/src/database/bun-sql.ts`
- Modify: `packages/bunderstack/src/database/postgres-js.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/database/adapter.test.ts`
- Test: `packages/bunderstack/src/app-env.test.ts`

**Interfaces:**

- Consumes: `DatabaseConnectOptions.introspect` from Task 2.
- Produces: every built-in `connect(schema, connection, { introspect: true })` returns `{ db: drizzle.mock({ schema }) }` without validating or opening `connection.url`.

- [ ] **Step 1: Write failing mock-mode tests for every adapter**

In `database/adapter.test.ts`, parameterize the four factories and intentionally supply unusable URLs:

```ts
test.each([
  ['libsql', libsql(), 'postgres://must-not-connect'],
  ['pglite', pglite(), 'postgres://must-not-connect'],
  ['bun-sql', bunSql(), ':memory:'],
  ['postgres-js', postgresJs(), ':memory:'],
] as const)(
  '%s adapter uses a mock during introspection',
  async (_name, adapter, url) => {
    const result = await adapter.connect(
      schemaFor(adapter.dialect),
      { url },
      {
        introspect: true,
      },
    )
    expect(result.db).toBeDefined()
    expect(result.close).toBeUndefined()
  },
)
```

Use the file's sqlite and pg schemas through a small local `schemaFor(dialect)` function returning the appropriate schema. No server or temporary directory should be created.

- [ ] **Step 2: Run the adapter tests and verify they fail**

Run:

```bash
bun test --cwd packages/bunderstack src/database/adapter.test.ts
```

Expected: at least Bun SQL and postgres.js reject `:memory:` or attempt a real connection.

- [ ] **Step 3: Implement mock mode before URL checks**

At the beginning of each adapter's `connect`, add the dialect-specific mock return:

```ts
async connect(schema, connection, { introspect }) {
  if (introspect) return { db: drizzle.mock({ schema }) as never }

  // existing adapter-specific URL validation and real connection construction
}
```

Do not attach a `close` callback to a mock database because `drizzle.mock()` has no real client.

- [ ] **Step 4: Remove introspection URL mutation from `createBunderstack`**

Delete:

```ts
if (introspect) {
  config.database.url = ':memory:'
  config.database.authToken = undefined
}
```

Keep `const introspect = process.env.BUNDERSTACK_INTROSPECT === '1'`, pass it to `createDb`, and retain the existing Redis suppression. Update the comment to state that adapters construct Drizzle mocks and no external services are touched.

- [ ] **Step 5: Add the exact server-adapter regression test**

In `app-env.test.ts`, define a pg schema, set `BUNDERSTACK_INTROSPECT=1`, configure `database: { adapter: bunSql(), url: 'postgres://example.invalid/app' }`, and call `createBunderstack`. Assert `app.manifest` is present and `await app.close()` succeeds. Restore the environment variable in `finally`.

The test must not require DNS or a Postgres process; passing proves that `drizzle.mock()` was selected.

- [ ] **Step 6: Verify introspection is offline for all adapters**

Run:

```bash
bun test --cwd packages/bunderstack src/database/adapter.test.ts src/app-env.test.ts
```

Expected: all tests pass without creating a new database directory and without a connection error.

- [ ] **Step 7: Commit adapter-neutral introspection**

```bash
git add packages/bunderstack/src/database packages/bunderstack/src/index.ts packages/bunderstack/src/app-env.test.ts
git commit -m "fix: keep introspection offline for every database adapter"
```

---

### Task 4: Correct peer dependency semantics

**Files:**

- Modify: `packages/bunderstack/package.json`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `scripts/dependency-boundaries.test.ts`

**Interfaces:**

- Consumes: package subpath exports introduced by the branch.
- Produces: required root peers, optional integration peers, and an explicit TypeScript policy.

- [ ] **Step 1: Add exact peer-metadata assertions**

Add to `scripts/dependency-boundaries.test.ts`:

```ts
test('bunderstack peer metadata matches runtime import boundaries', async () => {
  const pkg = await Bun.file(
    join(repoRoot, 'packages/bunderstack/package.json'),
  ).json()

  expect(pkg.peerDependencies['better-auth']).toBe('^1.0.0')
  expect(pkg.peerDependenciesMeta?.['better-auth']).toBeUndefined()
  expect(pkg.peerDependencies.nodemailer).toBe('>=6 <10')
  expect(pkg.peerDependenciesMeta.nodemailer.optional).toBe(true)
  expect(pkg.peerDependencies.typescript).toBe('>=5')
  expect(pkg.peerDependenciesMeta.typescript.optional).toBe(true)
})
```

- [ ] **Step 2: Run the metadata test and verify it fails**

Run:

```bash
bun test scripts/dependency-boundaries.test.ts -t "peer metadata"
```

Expected: FAIL because `better-auth` is optional and `nodemailer` has an empty range.

- [ ] **Step 3: Fix the manifest**

In `packages/bunderstack/package.json`:

- keep `"better-auth": "^1.0.0"` in `peerDependencies`;
- remove only `better-auth` from `peerDependenciesMeta`;
- set `"nodemailer": ">=6 <10"`;
- keep `"typescript": ">=5"` and its optional metadata;
- keep PGlite, libSQL, drizzle-kit, nodemailer, and postgres.js optional.

Do not broaden TypeScript to `"*"`: source publication requires modern syntax/type support, and `>=5` already allows every TypeScript 5, 6, and later major.

- [ ] **Step 4: Regenerate only dependency state implied by manifests**

First ensure unrelated example manifest changes are absent, then run:

```bash
bun install --lockfile-only
git diff -- bun.lock packages/bunderstack/package.json package.json
```

Expected: the lockfile reflects the reviewed manifests and does not add an unrelated PGlite dependency to `examples/tldraw`.

- [ ] **Step 5: Run the boundary suite**

Run:

```bash
bun test scripts/dependency-boundaries.test.ts
```

Expected: all source/export/peer boundary tests pass.

- [ ] **Step 6: Commit peer metadata**

```bash
git add package.json packages/bunderstack/package.json bun.lock scripts/dependency-boundaries.test.ts
git commit -m "fix: align peer metadata with runtime imports"
```

---

### Task 5: Enforce query and browser bundle boundaries

**Files:**

- Modify: `packages/bunderstack-query/src/client.ts`
- Modify: `scripts/dependency-boundaries.test.ts`
- Create: `scripts/bundle-boundaries.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `bunderstack-query`, `bunderstack-query/client`, `bunderstack-query/trpc`, and `bunderstack-start` export maps.
- Produces: source-level and real-bundle guards that catch accidental eager imports.

- [ ] **Step 1: Add a source-level type-import test**

Add this test:

```ts
test('query client keeps QueryClient type-only', async () => {
  const source = await Bun.file(
    join(repoRoot, 'packages/bunderstack-query/src/client.ts'),
  ).text()

  expect(source).toContain(
    "import type { QueryClient } from '@tanstack/react-query'",
  )
  expect(source).not.toMatch(
    /import\s+\{\s*QueryClient\s*\}\s+from\s+['"]@tanstack\/react-query['"]/,
  )
})
```

- [ ] **Step 2: Run it and verify the current branch implementation fails**

Run:

```bash
bun test scripts/dependency-boundaries.test.ts -t "QueryClient type-only"
```

Expected: FAIL against the implementation from `650541d` because it uses a value import.

- [ ] **Step 3: Convert the import to type-only**

In `packages/bunderstack-query/src/client.ts`, use exactly:

```ts
import type { QueryClient } from '@tanstack/react-query'
```

Do not change runtime behavior; `QueryClient` is used only in annotations.

- [ ] **Step 4: Create the browser bundle test harness**

Create `scripts/bundle-boundaries.test.ts` with a helper that builds an in-memory browser bundle:

```ts
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')

async function bundle(entrypoint: string, external: string[] = []) {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, entrypoint)],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: true,
    sourcemap: 'none',
    metafile: true,
    external,
    write: false,
  })
  expect(result.success, result.logs.map(String).join('\n')).toBe(true)
  expect(result.outputs).toHaveLength(1)
  const output = result.outputs[0]!
  return {
    text: await output.text(),
    size: output.size,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  }
}
```

- [ ] **Step 5: Add concrete bundle contracts**

Add tests with these assertions:

```ts
describe('browser bundle boundaries', () => {
  test('query root stays schema-only', async () => {
    const output = await bundle('packages/bunderstack-query/src/index.ts')
    expect(output.size).toBeLessThan(32 * 1024)
    expect(
      output.inputs.some((path) => path.includes('@tanstack/react-query')),
    ).toBe(false)
    expect(output.inputs.some((path) => path.includes('@trpc'))).toBe(false)
    expect(output.inputs.some((path) => path.includes('superjson'))).toBe(false)
    expect(output.inputs.some((path) => path.includes('better-auth'))).toBe(
      false,
    )
    expect(
      output.inputs.some((path) => path.includes('packages/bunderstack/src')),
    ).toBe(false)
  })

  test('start root keeps TanStack server external and excludes auth', async () => {
    const output = await bundle('packages/bunderstack-start/src/index.ts', [
      '@tanstack/react-start/server',
      '@tanstack/react-query',
      'bunderstack-sync',
    ])
    expect(output.size).toBeLessThan(32 * 1024)
    expect(output.inputs.some((path) => path.includes('better-auth'))).toBe(
      false,
    )
    expect(output.inputs.some((path) => path.includes('/auth'))).toBe(false)
  })
})
```

The 32 KiB ceiling is deliberately generous relative to the reviewed 8.6 KiB query bundle while still detecting accidental integration bundling. `QueryClient` cannot be forbidden as an output substring because it is part of the public identifier `createBunderstackQueryClient`; metafile inputs are the authoritative runtime-dependency check. The Start test externalizes its three deliberate runtime peers and verifies that the root entrypoint does not pull in its optional auth subpath.

- [ ] **Step 6: Expose and run the bundle suite**

Add to root `package.json`:

```json
"test:bundles": "bun test scripts/bundle-boundaries.test.ts"
```

Run:

```bash
bun run test:boundaries
bun run test:bundles
```

Expected: both scripts pass; the root query bundle remains below 32768 bytes.

- [ ] **Step 7: Commit bundle guards**

```bash
git add packages/bunderstack-query/src/client.ts scripts/dependency-boundaries.test.ts scripts/bundle-boundaries.test.ts package.json
git commit -m "test: enforce browser bundle boundaries"
```

---

### Task 6: Reapply the reviewed adapter, SMTP, and consumer migrations only

**Files:**

- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/email.ts`
- Create/modify: `packages/bunderstack/src/email/smtp.ts`
- Modify: focused tests adjacent to those files
- Modify: only consumer files that import moved entrypoints or construct `database` config

**Interfaces:**

- Consumes: `libsql()`, `pglite()`, `bunSql()`, `postgresJs()`, and `smtp()` public factories.
- Produces: explicit consumer imports with no runtime-selected module specifiers.

- [ ] **Step 1: Restore the intended implementation files from the reviewed commit without committing**

Run:

```bash
git restore --source=650541d -- packages/bunderstack/src/email.ts packages/bunderstack/src/email.test.ts packages/bunderstack/src/email/smtp.ts packages/bunderstack/src/email/smtp.test.ts
```

Expected: only explicit-adapter, SMTP-subpath, and provisioning changes appear. Do not restore all of `packages/bunderstack/src`, because that would reintroduce formatting churn and `@ts-nocheck`.

- [ ] **Step 2: Migrate each example's server config explicitly**

For sqlite examples, add:

```ts
import { libsql } from 'bunderstack/database/libsql'

database: {
  adapter: libsql(),
}
```

For local pg/PGlite examples, add:

```ts
import { pglite } from 'bunderstack/database/pglite'

database: {
  adapter: pglite(),
}
```

For a production Bun SQL example, use `bunSql()` from `bunderstack/database/bun-sql`. Change only `src/bunderstack.ts` and the relevant package manifest; do not change schemas, migrations, routes, UI components, generated files, or test fixtures.

- [ ] **Step 3: Migrate client imports to the new explicit subpaths**

Use:

```ts
import { createClient } from 'bunderstack-query'
import { createTRPCClient } from 'bunderstack-query/trpc'
import { createStartAuthClient } from 'bunderstack-start/auth'
```

Select only the imports actually used by each consumer. The reviewed packages do not export `bunderstack-query/client` or the longer `createBunderstack*` aliases; do not invent new aliases or export-map entries in this task. Do not add a dependency merely because another example has it.

- [ ] **Step 4: Verify config and email behavior**

Run:

```bash
bun test --cwd packages/bunderstack src/config.test.ts src/email.test.ts src/email/smtp.test.ts src/provision.test.ts
bun run typecheck
```

Expected: all selected tests and all four package typechecks pass.

- [ ] **Step 5: Verify no variable dynamic import was reintroduced**

Run:

```bash
rg -n "import\\([^'\"]|vite-ignore" packages/bunderstack/src packages/bunderstack-query/src packages/bunderstack-start/src
```

Expected: no matches.

- [ ] **Step 6: Commit the focused consumer migration**

Stage only the files shown by:

```bash
git diff --name-only
```

Reject any generated route, migration, historical plan, website JSON, or unrelated UI path before committing. Then commit:

```bash
git commit -m "refactor: use explicit database and email integrations"
```

---

### Task 7: Update every canonical public example and dependency document

**Files:**

- Modify: `README.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `docs/dependency-model.md`
- Modify: `website/content/docs/getting-started.mdx`
- Modify: `website/content/docs/configuration.mdx`
- Modify: `website/content/docs/api-reference.mdx`
- Modify: `website/content/docs/email.mdx`
- Modify: `examples/README.md`
- Modify: `examples/todo/README.md`
- Test: `scripts/dependency-boundaries.test.ts`

**Interfaces:**

- Consumes: public subpaths and peer rules from Tasks 3–6.
- Produces: copy-pasteable quick starts that always supply `database.adapter`, document `smtp()` rather than `'smtp'`, and accurately explain optional peers.

- [ ] **Step 1: Add documentation contract tests**

Add tests that load the canonical quick-start/config files and assert:

```ts
test('canonical docs show an explicit database adapter', async () => {
  for (const path of [
    'README.md',
    'packages/bunderstack/README.md',
    'website/content/docs/getting-started.mdx',
    'website/content/docs/configuration.mdx',
    'website/content/docs/email.mdx',
  ]) {
    const source = await Bun.file(join(repoRoot, path)).text()
    expect(source, path).toContain('adapter: libsql()')
    expect(source, path).toContain('bunderstack/database/libsql')
  }
})

test('configuration docs use the SMTP factory', async () => {
  const source = await Bun.file(
    join(repoRoot, 'website/content/docs/configuration.mdx'),
  ).text()
  expect(source).toContain('bunderstack/email/smtp')
  expect(source).toContain('email: smtp(')
  expect(source).not.toContain("email: 'smtp'")
})
```

- [ ] **Step 2: Run the doc guards and verify stale documentation fails**

Run:

```bash
bun test scripts/dependency-boundaries.test.ts -t "canonical docs|SMTP factory"
```

Expected: FAIL until root/package/website quick starts include the adapter and configuration no longer uses `'smtp'`.

- [ ] **Step 3: Update all quick starts with complete imports**

Every sqlite quick start must include:

```ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'

const app = await createBunderstack({
  schema,
  database: {
    adapter: libsql(),
    url: 'file:./data.db',
  },
})
```

Do not show `database: { url }` without `adapter` anywhere in canonical docs.

- [ ] **Step 4: Document adapter selection and introspection behavior**

In `docs/dependency-model.md` and `website/content/docs/configuration.mdx`, state:

- import one adapter from `bunderstack/database/<adapter>`;
- install only that adapter's optional peer;
- `BUNDERSTACK_INTROSPECT=1` uses that adapter's Drizzle mock and performs no database connection;
- PGlite/libSQL/postgres.js/Bun SQL real clients are owned by the app and closed by `app.close()`.

List the four adapter subpaths and their corresponding peers explicitly.

- [ ] **Step 5: Document peer policy including TypeScript**

In `docs/dependency-model.md`, state that `better-auth`, Drizzle ORM, Hono, and Zod are required because the root entrypoint uses them; drivers, Nodemailer, drizzle-kit, and TypeScript are optional peers. Explain that TypeScript remains `>=5` because the package publishes `.ts` source, while optional metadata avoids forcing TypeScript into Bun installations that already transpile source.

- [ ] **Step 6: Run documentation and boundary tests**

Run:

```bash
bun test scripts/dependency-boundaries.test.ts
```

Expected: all documentation, peer, export, and source-boundary assertions pass.

- [ ] **Step 7: Commit public documentation**

```bash
git add README.md packages/bunderstack/README.md docs/dependency-model.md website/content/docs/getting-started.mdx website/content/docs/configuration.mdx website/content/docs/api-reference.mdx examples/README.md examples/todo/README.md scripts/dependency-boundaries.test.ts
git commit -m "docs: explain explicit integration boundaries"
```

---

### Task 8: Audit scope, format only intended files, and run the full release gate

**Files:**

- Inspect: every path in `git diff --name-only main...HEAD`
- Modify only when needed: files already listed in Tasks 1–7

**Interfaces:**

- Consumes: all prior tasks.
- Produces: a focused, green branch suitable for final review.

- [ ] **Step 1: Prove forbidden path classes are absent**

Run:

```bash
git diff --name-only main...HEAD | rg '(^docs/(plans|superpowers/(plans|specs))/.*2026-0[1-6]|routeTree\.gen\.ts$|migrations/meta/|website/src/lib/.*\.gen\.json$|scripts/publish-changed)'
```

Expected: no output. The new plan file dated `2026-07-22` is not part of the execution branch unless the user explicitly asks to copy it there.

- [ ] **Step 2: Audit every example change**

Run:

```bash
git diff --name-only main...HEAD | rg '^examples/'
```

Expected: only package manifests, `src/bunderstack.ts`, required auth/API client import files, and the two documentation files listed in Task 7. Any component, route, schema, migration, generated file, stress script, or test utility is out of scope and must be restored from `main` before continuing.

- [ ] **Step 3: Audit the final diff size and content**

Run:

```bash
git diff --stat main...HEAD
git diff --check main...HEAD
git status --short
```

Expected: substantially fewer than the reviewed 235 files; `git diff --check` prints nothing; working tree is clean after committed fixes.

- [ ] **Step 4: Run formatting and lint without accepting scope expansion**

Run:

```bash
bun run format
bun run lint
git diff --name-only
```

Expected: formatter/linter changes only files already in the intended diff. Restore any unrelated formatter churn from `HEAD`; do not commit repository-wide reformatting.

- [ ] **Step 5: Run the focused release gates**

Run:

```bash
bun run typecheck
bun run test:boundaries
bun run test:bundles
```

Expected: all commands exit 0.

- [ ] **Step 6: Run the full test suite and confirm the original exit-99 failure is gone**

Run:

```bash
bun run test
```

Expected: all workspace suites finish, the core suite no longer stops the command with exit 99, and there are zero failed tests.

- [ ] **Step 7: Inspect the packed package manifests**

Run:

```bash
bun pm pack --cwd packages/bunderstack --dry-run
bun pm pack --cwd packages/bunderstack-query --dry-run
bun pm pack --cwd packages/bunderstack-start --dry-run
```

Expected: published files contain the intended TypeScript entrypoints, omit test files, and expose only declared package subpaths. If the installed Bun version does not support `--dry-run`, run `bun pm pack` in a temporary directory outside the repository and inspect the printed file list without committing the tarballs.

- [ ] **Step 8: Commit formatter-only corrections if any**

If Step 4 changed intended files:

```bash
git add <only-the-already-intended-files-reported-by-git-diff>
git commit -m "style: format dependency boundary changes"
```

If no files changed, do not create an empty commit.

- [ ] **Step 9: Prepare the final handoff summary**

Report these exact items to the reviewer:

- final file count and insertion/deletion count from `git diff --stat main...HEAD`;
- exit codes for `typecheck`, `test:boundaries`, `test:bundles`, and full `test`;
- measured query-root bundle size;
- confirmation that the PGlite nested-directory test exits 0;
- confirmation that Bun SQL introspection succeeds without a server;
- confirmation that `better-auth` is required, Nodemailer is `>=6 <10`, and TypeScript remains optional `>=5`.

---

## Recommended execution checkpoints

1. After Tasks 1–3: review the adapter contract, cleanup ordering, PGlite exit code, and offline introspection before touching manifests/docs.
2. After Tasks 4–5: review package metadata and real browser bundle evidence.
3. After Tasks 6–8: review final scope and the complete release gate.

This is not a small inline patch. It changes a public adapter interface, resource ownership, four driver implementations, introspection semantics, manifests, bundle CI, examples, and documentation. The clean-branch reconstruction also requires careful diff curation. It is best assigned to an execution agent with the checkpoints above; inline execution is still reasonable if performed in three reviewed batches rather than one uninterrupted change.
