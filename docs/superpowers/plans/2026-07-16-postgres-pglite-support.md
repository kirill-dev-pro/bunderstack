# PostgreSQL + PGlite Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PostgreSQL as a second dialect (inferred from the Drizzle schema) with PGlite for zero-config local development, real Postgres (`Bun.sql` / postgres.js) in production.

**Architecture:** The schema's table brand (`pgTable` vs `sqliteTable`) selects the dialect; `DATABASE_URL` selects the engine within it. All drivers become optional peers loaded via dynamic import. Internal modules switch from `LibSQLDatabase` typing to a minimal structural `AnyDb` and dispatch internal-table twins at runtime via `is(db, PgDatabase)`. `createBunderstack` becomes async.

**Tech Stack:** Bun, drizzle-orm 0.45 (`libsql`, `pglite`, `bun-sql`, `postgres-js` drivers), drizzle-kit/api (`pushSQLiteSchema`, `pushSchema`), @electric-sql/pglite, better-auth drizzle adapter.

**Spec:** `docs/superpowers/specs/2026-07-16-postgres-pglite-support-design.md`

## Global Constraints

- Run everything with Bun (`bun test`, `bun add`, `bunx`); never npm/npx/vitest.
- Package tests baseline: all green as of 2026-07-13. Every task ends with `bun test` green in `packages/bunderstack` (repo-level known failures: Start-example vite build, 8 tldraw tsc errors — pre-existing, not ours).
- Error messages start with `[bunderstack] ` and include the exact fix command (e.g. `bun add -d @electric-sql/pglite`).
- Every dynamic import of an optional module carries `/* @vite-ignore */ /* webpackIgnore: true */` comments (bundler safety — same pattern as drizzle-kit in provision.ts).
- Peer ranges: `drizzle-orm ^0.45.0` (required), `@libsql/client ^0.14.0`, `@electric-sql/pglite` (pin `^<installed major.minor>` after install), `postgres ^3.4.0`, `drizzle-kit ^0.30.0` — all but drizzle-orm optional.
- `createBunderstack` returns `Promise<BunderstackApp<…>>`; all three overloads.
- URL classification: `postgres://`/`postgresql://` = pg server; `libsql:`/`ws(s):`/`http(s):` = libsql remote; everything else under a pg schema = PGlite data dir (`file:` prefix stripped; `:memory:` normalized to `memory://`).
- Working directory for all commands: `/Users/kirill/pet-projects/bunderstack/packages/bunderstack` unless stated otherwise.

---

### Task 1: Dependency restructure (peers + devDeps + subpath exports)

Move drizzle-orm and @libsql/client out of `dependencies`, add the new optional drivers, keep the package's own tests running via devDependencies. No source changes — the suite must stay green.

**Files:**

- Modify: `packages/bunderstack/package.json`

**Interfaces:**

- Produces: installed devDeps `@electric-sql/pglite`, `drizzle-orm`, `@libsql/client`, `drizzle-kit` (later tasks import `drizzle-orm/pglite` in tests); package `exports` entries `./schema/pg` → `./src/schema-export-pg.ts`, `./typeid/pg` → `./src/typeid-pg.ts` (files created in Task 9).

- [ ] **Step 1: Rewrite the dependency blocks in `package.json`**

Replace the `dependencies`/`peerDependencies`/`peerDependenciesMeta` blocks and add `devDependencies` and the two new `exports` entries:

```json
  "exports": {
    ".": "./src/index.ts",
    "./access": "./src/access.ts",
    "./provision": "./src/provision.ts",
    "./schema": "./src/schema-export.ts",
    "./schema/pg": "./src/schema-export-pg.ts",
    "./typeid": "./src/typeid.ts",
    "./typeid/pg": "./src/typeid-pg.ts",
    "./env": "./src/env.ts",
    "./trpc": "./src/trpc.ts"
  },
```

```json
  "dependencies": {
    "@trpc/server": "^11.0.0",
    "better-auth": "^1.0.0",
    "hono": "^4.0.0",
    "superjson": "^2.2.0",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@electric-sql/pglite": "^0.3.0",
    "@libsql/client": "^0.14.0",
    "drizzle-kit": "^0.30.0",
    "drizzle-orm": "^0.45.0",
    "nodemailer": "^6",
    "postgres": "^3.4.0",
    "typescript": "^5"
  },
  "peerDependenciesMeta": {
    "@electric-sql/pglite": { "optional": true },
    "@libsql/client": { "optional": true },
    "drizzle-kit": { "optional": true },
    "nodemailer": { "optional": true },
    "postgres": { "optional": true }
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.3.0",
    "@libsql/client": "^0.14.0",
    "drizzle-kit": "^0.30.0",
    "drizzle-orm": "^0.45.0"
  }
```

- [ ] **Step 2: Install and pin the PGlite range**

Run (repo root): `bun install`
Then check the installed version: `cat packages/bunderstack/node_modules/@electric-sql/pglite/package.json | grep '"version"'`
If the installed major.minor differs from `0.3`, update both the peer and dev ranges to `^<installed major.minor>` and re-run `bun install`.

- [ ] **Step 3: Verify the suite is untouched**

Run: `bun test` (in `packages/bunderstack`)
Expected: same green result as baseline.

Note: examples resolve drizzle-orm through bunderstack's dependency today; after this task they may fail to resolve it until Task 10 adds explicit deps. That interim breakage is expected — package tests are the gate.

- [ ] **Step 4: Commit**

```bash
git add packages/bunderstack/package.json bun.lock
git commit -m "chore(bunderstack): drizzle-orm to peer deps; optional driver peers (libsql, pglite, postgres)"
```

---

### Task 2: Dialect detection module

**Files:**

- Create: `packages/bunderstack/src/dialect.ts`
- Test: `packages/bunderstack/src/dialect.test.ts`

**Interfaces:**

- Produces: `type Dialect = 'sqlite' | 'pg'`; `detectDialect(schema: Record<string, unknown>): Dialect` (throws on mixed); `type AnyDb = { select/insert/update/delete: (...args: any[]) => any }` — the db param type every internal module adopts in later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// src/dialect.test.ts
import { test, expect } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { detectDialect } from './dialect'

const sqlitePosts = sqliteTable('posts', { id: text('id').primaryKey() })
const pgPosts = pgTable('posts', { id: pgText('id').primaryKey() })

test('sqlite-only schema detects sqlite', () => {
  expect(detectDialect({ posts: sqlitePosts })).toBe('sqlite')
})

test('pg-only schema detects pg', () => {
  expect(detectDialect({ posts: pgPosts })).toBe('pg')
})

test('empty schema defaults to sqlite', () => {
  expect(detectDialect({})).toBe('sqlite')
})

test('non-table values (relations, helpers) are ignored', () => {
  expect(detectDialect({ posts: pgPosts, helper: () => 1, n: 42 })).toBe('pg')
})

test('mixed dialects throw with both table keys named', () => {
  expect(() => detectDialect({ a: pgPosts, b: sqlitePosts })).toThrow(
    /mixes dialects.*"a".*"b"/s,
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/dialect.test.ts`
Expected: FAIL — cannot resolve `./dialect`.

- [ ] **Step 3: Implement `dialect.ts`**

```ts
// src/dialect.ts — schema-driven dialect detection. Imports only dialect-core
// drizzle entrypoints (no drivers), safe in every module graph.
import { is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'

export type Dialect = 'sqlite' | 'pg'

/**
 * Minimal structural view of a drizzle db shared by both dialects. Internal
 * modules run dynamic tables (Record<string, unknown> schemas) where drizzle's
 * generics add no safety, so they accept this instead of a per-dialect union.
 * The public surface (`app.db`, tRPC ctx) keeps full per-dialect typing via
 * `DbFor` in db.ts.
 */
export type AnyDb = {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
  delete: (...args: any[]) => any
}

/** Classify a schema by its table brands. Mixed dialects are a config error. */
export function detectDialect(schema: Record<string, unknown>): Dialect {
  let pgKey: string | undefined
  let sqliteKey: string | undefined
  for (const [key, value] of Object.entries(schema)) {
    if (is(value, PgTable)) pgKey ??= key
    else if (is(value, SQLiteTable)) sqliteKey ??= key
  }
  if (pgKey !== undefined && sqliteKey !== undefined) {
    throw new Error(
      `[bunderstack] schema mixes dialects: "${pgKey}" is a Postgres table while "${sqliteKey}" is a SQLite table. ` +
        'Define every table with the same dialect (drizzle-orm/pg-core or drizzle-orm/sqlite-core).',
    )
  }
  return pgKey !== undefined ? 'pg' : 'sqlite'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/dialect.test.ts`
Expected: 5 pass. Then `bun test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/dialect.ts src/dialect.test.ts
git commit -m "feat(bunderstack): schema-driven dialect detection"
```

---

### Task 3: Postgres twins of the internal tables

**Files:**

- Create: `packages/bunderstack/src/internal-tables-pg.ts`
- Modify: `packages/bunderstack/src/internal-tables.ts`
- Test: `packages/bunderstack/src/internal-tables.test.ts` (append)

**Interfaces:**

- Consumes: `detectDialect` from Task 2.
- Produces: `bunderstackFilesPg`, `bunderstackIdempotencyPg` (pg twins, same table/column names, `$inferSelect`-compatible shapes); `filesTableFor(db: unknown)` and `idempotencyTableFor(db: unknown)` — runtime dispatch by `is(db, PgDatabase)`, used by Task 4; `withInternalTables(schema)` now merges the dialect-matching twin set.

- [ ] **Step 1: Write the failing tests (append to `internal-tables.test.ts`)**

```ts
import { is } from 'drizzle-orm'
import { PgTable, pgTable, text as pgText } from 'drizzle-orm/pg-core'

import {
  bunderstackFilesPg,
  bunderstackIdempotencyPg,
} from './internal-tables-pg'

const pgPosts = pgTable('pg_posts', { id: pgText('id').primaryKey() })

test('withInternalTables merges pg twins into a pg schema', () => {
  const merged = withInternalTables({ pgPosts })
  expect(is(merged.bunderstackFiles, PgTable)).toBe(true)
  expect(is(merged.bunderstackIdempotency, PgTable)).toBe(true)
})

test('withInternalTables accepts the pg twins re-exported into the schema', () => {
  const merged = withInternalTables({
    pgPosts,
    bunderstackFiles: bunderstackFilesPg,
    bunderstackIdempotency: bunderstackIdempotencyPg,
  })
  expect(merged.bunderstackFiles).toBe(bunderstackFilesPg as never)
})

test('withInternalTables still rejects foreign pg tables using reserved names', () => {
  const impostor = pgTable('bunderstack_file_meta', {
    id: pgText('id').primaryKey(),
  })
  expect(() => withInternalTables({ impostor })).toThrow(/reserved/)
})
```

(Match the existing file's import style — it already imports `withInternalTables`, `test`, `expect`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/internal-tables.test.ts`
Expected: FAIL — cannot resolve `./internal-tables-pg`.

- [ ] **Step 3: Create `internal-tables-pg.ts`**

```ts
// src/internal-tables-pg.ts — Postgres twins of the internal tables. Same
// table/column names and row shapes as the sqlite originals; timestamps stay
// integer milliseconds (bigint mode:number) so shared code never branches.
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core'

export const bunderstackFilesPg = pgTable(
  'bunderstack_file_meta',
  {
    fileId: text('file_id').primaryKey(),
    bucket: text('bucket').notNull(),
    ownerId: text('owner_id'),
    scopeJson: text('scope_json'),
    status: text('status').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    confirmedAt: bigint('confirmed_at', { mode: 'number' }),
  },
  (t) => [
    index('bfm_owner').on(t.ownerId),
    index('bfm_scope').on(t.bucket, t.scopeJson),
    index('bfm_sweep').on(t.status, t.createdAt),
  ],
)

export const bunderstackIdempotencyPg = pgTable(
  '_bunderstack_idempotency',
  {
    key: text('key').notNull(),
    tableName: text('table_name').notNull(),
    bodyHash: text('body_hash').notNull(),
    status: integer('status').notNull(),
    response: text('response').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.tableName] })],
)
```

- [ ] **Step 4: Update `internal-tables.ts`**

Add imports and dispatch helpers, and make `withInternalTables` dialect-aware:

```ts
import { getTableName, is, isTable } from 'drizzle-orm'
import { PgDatabase } from 'drizzle-orm/pg-core'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

import { detectDialect } from './dialect'
import {
  bunderstackFilesPg,
  bunderstackIdempotencyPg,
} from './internal-tables-pg'
```

Keep the two sqlite table definitions and `INTERNAL_TABLES` / `INTERNAL_TABLE_NAMES` unchanged. Replace `INTERNAL_TABLE_BY_NAME` (single table per name) with a candidates list covering both dialects, and add the dispatch helpers:

```ts
export const INTERNAL_TABLES_PG = {
  bunderstackFiles: bunderstackFilesPg,
  bunderstackIdempotency: bunderstackIdempotencyPg,
} as const

// Both dialect twins count as "ours" for the re-export identity check.
const INTERNAL_TABLE_CANDIDATES = new Map<string, readonly unknown[]>([
  [getTableName(bunderstackFiles), [bunderstackFiles, bunderstackFilesPg]],
  [
    getTableName(bunderstackIdempotency),
    [bunderstackIdempotency, bunderstackIdempotencyPg],
  ],
])

/** Internal file-meta table matching the db's dialect. */
export function filesTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackFilesPg : bunderstackFiles
}

/** Internal idempotency table matching the db's dialect. */
export function idempotencyTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackIdempotencyPg : bunderstackIdempotency
}
```

In `withInternalTables`: replace the `INTERNAL_TABLE_BY_NAME.get(name)` / `internal === value` check with

```ts
const candidates = INTERNAL_TABLE_CANDIDATES.get(name)
if (candidates?.includes(value)) {
  // Re-exported from bunderstack/schema(-pg) — already in user schema.
  continue
}
```

and pick the merge set by dialect (the return type keeps the sqlite `typeof INTERNAL_TABLES` shape — a knowing simplification; internal consumers use the runtime dispatch helpers, never this static type):

```ts
const internal =
  detectDialect(schema) === 'pg' ? INTERNAL_TABLES_PG : INTERNAL_TABLES
for (const [key, table] of Object.entries(internal)) {
  if (!(key in merged)) {
    ;(merged as Record<string, unknown>)[key] = table
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/internal-tables.test.ts` → new tests pass. Then `bun test` → full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/internal-tables-pg.ts src/internal-tables.ts src/internal-tables.test.ts
git commit -m "feat(bunderstack): pg twins of internal tables with runtime dispatch"
```

---

### Task 4: Dialect dispatch in file-meta and idempotency

**Files:**

- Modify: `packages/bunderstack/src/storage/file-meta.ts`
- Modify: `packages/bunderstack/src/idempotency.ts`
- Test: `packages/bunderstack/src/storage/file-meta.pg.test.ts` (new)

**Interfaces:**

- Consumes: `AnyDb` (Task 2), `filesTableFor`/`idempotencyTableFor` (Task 3).
- Produces: every exported function keeps its exact current name and signature except the `db` parameter type changes `LibSQLDatabase<Record<string, unknown>>` → `AnyDb` (callers compile unchanged — `LibSQLDatabase` is assignable to `AnyDb`).

- [ ] **Step 1: Write the failing pg test**

```ts
// src/storage/file-meta.pg.test.ts — internal-table dispatch on a real PGlite db.
import { test, expect, beforeAll } from 'bun:test'
import { sql } from 'drizzle-orm'

import type { AnyDb } from '../dialect'

import {
  getFileMeta,
  insertPendingFile,
  markFileReady,
  sumReadySize,
} from './file-meta'
import { lookupIdempotency, storeIdempotency } from '../idempotency'

let db: AnyDb & { execute: (q: unknown) => Promise<unknown> }

beforeAll(async () => {
  const { drizzle } = await import('drizzle-orm/pglite')
  const pgdb = drizzle('memory://')
  await pgdb.execute(sql`
    CREATE TABLE bunderstack_file_meta (
      file_id text PRIMARY KEY, bucket text NOT NULL, owner_id text,
      scope_json text, status text NOT NULL, filename text,
      content_type text, size bigint, created_at bigint NOT NULL,
      confirmed_at bigint
    )`)
  await pgdb.execute(sql`
    CREATE TABLE _bunderstack_idempotency (
      key text NOT NULL, table_name text NOT NULL, body_hash text NOT NULL,
      status integer NOT NULL, response text NOT NULL, expires_at bigint NOT NULL,
      PRIMARY KEY (key, table_name)
    )`)
  db = pgdb as unknown as typeof db
})

test('file-meta round-trips on Postgres', async () => {
  await insertPendingFile(db, {
    fileId: 'avatars/f1',
    bucket: 'avatars',
    ownerId: 'u1',
    scopeJson: null,
    filename: 'a.png',
    contentType: 'image/png',
  })
  await markFileReady(db, 'avatars/f1', { size: 123, contentType: 'image/png' })
  const row = await getFileMeta(db, 'avatars/f1')
  expect(row?.status).toBe('ready')
  expect(Number(row?.size)).toBe(123)
  expect(await sumReadySize(db, { bucket: 'avatars', ownerId: 'u1' })).toBe(123)
})

test('idempotency replay works on Postgres (onConflictDoUpdate)', async () => {
  await storeIdempotency(db, 'posts', 'k1', '{"a":1}', 201, { id: 1 }, {})
  // Upsert path: same key, new response.
  await storeIdempotency(db, 'posts', 'k1', '{"a":1}', 201, { id: 2 }, {})
  const hit = await lookupIdempotency(db, 'posts', 'k1', '{"a":1}', {})
  expect(hit).toEqual({ type: 'replay', status: 201, response: '{"id":2}' })
  const conflict = await lookupIdempotency(db, 'posts', 'k1', '{"a":2}', {})
  expect(conflict).toEqual({ type: 'conflict' })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/storage/file-meta.pg.test.ts`
Expected: FAIL — runtime error from executing sqlite-branded table inserts against pg, or a type/SQL error (the current code hardwires the sqlite table objects).

- [ ] **Step 3: Rewrite `file-meta.ts` internals**

- Replace `import type { LibSQLDatabase } from 'drizzle-orm/libsql'` with `import type { AnyDb } from '../dialect'`.
- Replace the `import { bunderstackFiles } from '../internal-tables'` with `import { bunderstackFiles, filesTableFor } from '../internal-tables'` (`bunderstackFiles` is still needed for the `FileMetaRow` type).
- Change every `db: LibSQLDatabase<Record<string, unknown>>` parameter to `db: AnyDb`.
- In each db-touching function, resolve the table first and use it. Example (`insertPendingFile`; apply the same pattern to `insertReadyFile`, `markFileReady`, `getFileMeta`, `deleteFileMetaRow`, `listStalePendingFiles`, `sumReadySize`):

```ts
export async function insertPendingFile(
  db: AnyDb,
  input: {
    fileId: string
    bucket: string
    ownerId: string | null
    scopeJson: string | null
    filename: string | null
    contentType: string | null
  },
): Promise<void> {
  const files = filesTableFor(db)
  await db.insert(files).values({
    fileId: input.fileId,
    bucket: input.bucket,
    ownerId: input.ownerId,
    scopeJson: input.scopeJson,
    filename: input.filename,
    contentType: input.contentType,
    status: 'pending',
    createdAt: Date.now(),
    confirmedAt: null,
    size: null,
  })
}
```

`FileMetaRow` stays `typeof bunderstackFiles.$inferSelect` (the pg twin infers the identical shape). In `getFileMeta`/`listStalePendingFiles`, the query results come back as `any` through `AnyDb` — keep the declared return types (`Promise<FileMetaRow | null>` etc.) so callers are unaffected.

- [ ] **Step 4: Rewrite `idempotency.ts` internals the same way**

- `import type { AnyDb } from './dialect'`; drop the libsql import.
- `import { idempotencyTableFor } from './internal-tables'` (drop the direct `bunderstackIdempotency` import).
- Both `lookupIdempotency` and `storeIdempotency`: `db: AnyDb`, and `const t = idempotencyTableFor(db)` at the top, all column references via `t`.

- [ ] **Step 5: Run tests**

Run: `bun test src/storage/file-meta.pg.test.ts` → PASS.
Run: `bun test` → full suite green (sqlite paths use the sqlite twin via dispatch).

- [ ] **Step 6: Commit**

```bash
git add src/storage/file-meta.ts src/storage/file-meta.pg.test.ts src/idempotency.ts
git commit -m "feat(bunderstack): file-meta and idempotency dispatch internal tables by db dialect"
```

---

### Task 5: Async multi-driver `createDb` and async `createBunderstack`

The atomic core: db factory, env default, auth provider, type sweep, and every caller updated together so the suite lands green.

**Files:**

- Modify: `packages/bunderstack/src/db.ts` (rewrite)
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/env.ts`
- Modify: `packages/bunderstack/src/auth.ts`
- Modify: `packages/bunderstack/src/trpc.ts`
- Modify: `packages/bunderstack/src/provision-internals.ts`
- Modify: `packages/bunderstack/src/crud.ts`, `src/list-query.ts`, `src/storage/router.ts`, `src/storage/sweep.ts`, `src/storage/delete.ts` (db param types only)
- Modify tests: `src/db.test.ts`, `src/crud.test.ts`, `src/index.test.ts`, `src/access.integration.test.ts`, `src/app-env.test.ts`, `src/auth-email.test.ts`, `src/infer-client.test.ts`, `src/trpc-mount.test.ts`, `src/provision.integration.test.ts`, `src/storage/multibucket.integration.test.ts`, `packages/bunderstack-query/src/trpc-client.test.ts`
- Test: `packages/bunderstack/src/db.pg.test.ts` (new)

**Interfaces:**

- Consumes: `Dialect`, `AnyDb`, `detectDialect` (Task 2).
- Produces:
  - `type Driver = 'libsql' | 'pglite' | 'bun-sql' | 'postgres-js'`
  - `type DbFor<TSchema extends Record<string, unknown>>` — `PgDatabase<PgQueryResultHKT, TSchema>` when the schema contains a `PgTable`, else `LibSQLDatabase<TSchema>`
  - `createDb<TSchema>(schema, cfg: { url: string; authToken?: string; dialect: Dialect }): Promise<{ db: DbFor<TSchema>; driver: Driver }>`
  - `createBunderstack(...)` → `Promise<BunderstackApp<…>>` (all overloads); `BunderstackApp.db: DbFor<TSchema>`
  - `createAuth(db: AnyDb, cfg: BetterAuthConfig, dialect: Dialect)`
  - `validateEnv` options gain `defaultDatabaseUrl?: string`
  - `ProvisionInternals` gains `dialect: Dialect` and `driver: Driver`; `db` becomes `AnyDb` (Task 6 consumes both).

- [ ] **Step 1: Write the failing pg db test**

```ts
// src/db.pg.test.ts
import { test, expect } from 'bun:test'
import { pgTable, serial, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createDb } from './db'

const pgPosts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: pgText('title').notNull(),
})
const sqlitePosts = sqliteTable('posts', { id: text('id').primaryKey() })

test('pg schema + memory:// creates a working PGlite db', async () => {
  const { db, driver } = await createDb(
    { posts: pgPosts },
    { url: 'memory://', dialect: 'pg' },
  )
  expect(driver).toBe('pglite')
  await db.execute(
    `CREATE TABLE posts (id serial PRIMARY KEY, title text NOT NULL)` as never,
  )
  const rows = await db.insert(pgPosts).values({ title: 'hi' }).returning()
  expect(rows[0]?.title).toBe('hi')
})

test("pg schema + ':memory:' is normalized to in-memory PGlite", async () => {
  const { driver } = await createDb(
    { posts: pgPosts },
    { url: ':memory:', dialect: 'pg' },
  )
  expect(driver).toBe('pglite')
})

test('pg schema + postgres:// picks bun-sql under Bun without connecting', async () => {
  const { driver } = await createDb(
    { posts: pgPosts },
    { url: 'postgres://user:pw@localhost:5/db', dialect: 'pg' },
  )
  expect(driver).toBe('bun-sql')
})

test('sqlite schema + postgres:// URL throws a dialect-contradiction error', async () => {
  await expect(
    createDb(
      { posts: sqlitePosts },
      { url: 'postgres://x/y', dialect: 'sqlite' },
    ),
  ).rejects.toThrow(/Postgres URL.*sqliteTable/s)
})

test('pg schema + libsql URL throws a dialect-contradiction error', async () => {
  await expect(
    createDb(
      { posts: pgPosts },
      { url: 'libsql://foo.turso.io', dialect: 'pg' },
    ),
  ).rejects.toThrow(/libsql.*pgTable/s)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/db.pg.test.ts`
Expected: FAIL — current `createDb` is sync with a `{ url, authToken }` cfg.

- [ ] **Step 3: Rewrite `db.ts`**

```ts
// src/db.ts — dialect/driver dispatch. Every driver module loads via dynamic
// import so the driver packages stay optional peers; the ignore comments keep
// bundlers (vite/nitro, webpack) from resolving them at build time.
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { PgDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core'

import { mkdir } from 'node:fs/promises'

import type { Dialect } from './dialect'

export type Driver = 'libsql' | 'pglite' | 'bun-sql' | 'postgres-js'

/** Per-dialect public db type, computed from the schema's table brands. */
export type DbFor<TSchema extends Record<string, unknown>> = [
  Extract<TSchema[keyof TSchema], PgTable>,
] extends [never]
  ? LibSQLDatabase<TSchema>
  : PgDatabase<PgQueryResultHKT, TSchema>

const PG_SERVER_RE = /^postgres(ql)?:\/\//
const LIBSQL_REMOTE_RE = /^(libsql|wss?|https?):\/\//

async function importDriver<T>(specifier: string, hint: string): Promise<T> {
  try {
    return (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ specifier
    )) as T
  } catch (cause) {
    throw new Error(`[bunderstack] ${hint}`, { cause })
  }
}

export async function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: { url: string; authToken?: string; dialect: Dialect },
): Promise<{ db: DbFor<TSchema>; driver: Driver }> {
  if (cfg.dialect === 'sqlite') {
    if (PG_SERVER_RE.test(cfg.url)) {
      throw new Error(
        '[bunderstack] DATABASE_URL is a Postgres URL but the schema uses sqliteTable. ' +
          'Define the schema with drizzle-orm/pg-core, or point DATABASE_URL at a SQLite database.',
      )
    }
    const { drizzle } = await importDriver<typeof import('drizzle-orm/libsql')>(
      'drizzle-orm/libsql',
      'SQLite support requires @libsql/client, which is not installed.\n' +
        '  Run `bun add @libsql/client`.',
    )
    const db = drizzle({
      connection: { url: cfg.url, authToken: cfg.authToken },
      schema,
    })
    return { db: db as DbFor<TSchema>, driver: 'libsql' }
  }

  if (LIBSQL_REMOTE_RE.test(cfg.url)) {
    throw new Error(
      '[bunderstack] DATABASE_URL looks like a libsql/Turso URL but the schema uses pgTable. ' +
        'Set DATABASE_URL=postgres://… (or leave it unset for local PGlite).',
    )
  }

  if (PG_SERVER_RE.test(cfg.url)) {
    if (typeof Bun !== 'undefined') {
      const { drizzle } = await import(
        /* @vite-ignore */ /* webpackIgnore: true */ 'drizzle-orm/bun-sql'
      )
      return {
        db: drizzle(cfg.url, { schema }) as DbFor<TSchema>,
        driver: 'bun-sql',
      }
    }
    const { drizzle } = await importDriver<
      typeof import('drizzle-orm/postgres-js')
    >(
      'drizzle-orm/postgres-js',
      'Postgres on Node requires the `postgres` driver, which is not installed.\n' +
        '  Run `npm install postgres`. (Under Bun the built-in Bun.sql is used instead.)',
    )
    return {
      db: drizzle(cfg.url, { schema }) as DbFor<TSchema>,
      driver: 'postgres-js',
    }
  }

  // Local PGlite: `file:<dir>`, a bare path, `:memory:`, or `memory://`.
  const raw = cfg.url.startsWith('file:')
    ? cfg.url.slice('file:'.length)
    : cfg.url
  const dataDir = raw === ':memory:' ? 'memory://' : raw
  if (!dataDir.startsWith('memory://')) {
    await mkdir(dataDir, { recursive: true })
  }
  const { drizzle } = await importDriver<typeof import('drizzle-orm/pglite')>(
    'drizzle-orm/pglite',
    'Local Postgres development requires PGlite, which is not installed.\n' +
      '  Run `bun add -d @electric-sql/pglite` — bunderstack runs an embedded Postgres in ./data.pglite.\n' +
      '  In production set DATABASE_URL=postgres://… (PGlite is not needed there).',
  )
  return {
    db: drizzle(dataDir, { schema }) as DbFor<TSchema>,
    driver: 'pglite',
  }
}
```

- [ ] **Step 4: `env.ts` — dialect-aware default**

In `ValidateEnvOptions` add:

```ts
  /** Dialect-aware DATABASE_URL fallback; createBunderstack passes it. */
  defaultDatabaseUrl?: string
```

In `validateEnv`, change the base line to:

```ts
    DATABASE_URL:
      source.DATABASE_URL ?? options.defaultDatabaseUrl ?? 'file:./data.db',
```

- [ ] **Step 5: `auth.ts` — provider by dialect**

```ts
import type { AnyDb, Dialect } from './dialect'
// (drop the LibSQLDatabase import)

export function createAuth(db: AnyDb, cfg: BetterAuthConfig, dialect: Dialect) {
  return betterAuth({
    ...cfg,
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: dialect === 'pg' ? 'pg' : 'sqlite',
    }),
  })
}
```

- [ ] **Step 6: Type sweep — `AnyDb` in internal modules, `DbFor` on public surfaces**

Mechanical, same shape in every file (drop the `drizzle-orm/libsql` type import, import `AnyDb` from `./dialect` / `../dialect`):

- `crud.ts:64` — `db: LibSQLDatabase<TSchema>` → `db: AnyDb`
- `list-query.ts:328` — → `db: AnyDb`
- `storage/router.ts:38,514`, `storage/sweep.ts:15`, `storage/delete.ts:17`, `storage/file-meta.ts` (done in Task 4) — → `AnyDb`
- `trpc.ts:14` — `db: LibSQLDatabase<TSchema>` → `db: DbFor<TSchema>` with `import type { DbFor } from './db'`
- `provision-internals.ts`:

```ts
import type { AnyDb, Dialect } from './dialect'
import type { Driver } from './db'

export interface ProvisionInternals {
  /** Runtime db typed over the MERGED schema (user + internal tables). */
  db: AnyDb
  /** Merged schema used for push. */
  schema: Record<string, unknown>
  databaseUrl: string
  /** Resolved migrations folder (config `database.migrations`). */
  migrationsFolder: string
  dialect: Dialect
  driver: Driver
}
```

- `provision.ts:31` — `provisionSchema` first param `db: LibSQLDatabase<TSchema>` → `db: AnyDb` and pass `db as never` into `pushSQLiteSchema(schema, db as never)` if the drizzle-kit signature complains (Task 6 rewrites this function anyway; the minimal cast keeps this task compiling).

- [ ] **Step 7: `index.ts` — async factory**

1. All three overloads + implementation: `export function createBunderstack(...)` → `export async function createBunderstack(...)` returning `Promise<BunderstackApp<…>>` (wrap each overload's return type in `Promise<…>`).
2. Replace `import type { LibSQLDatabase } from 'drizzle-orm/libsql'` with `import type { DbFor } from './db'` and add `import { detectDialect } from './dialect'`.
3. `BunderstackApp` field: `db: DbFor<TSchema>`.
4. Implementation top:

```ts
const dialect = detectDialect(options.schema)
const env = validateEnv(options.env, {
  emailProvider: emailProviderTag(options.email),
  defaultDatabaseUrl:
    dialect === 'pg' ? 'file:./data.pglite' : 'file:./data.db',
})
```

5. Db + auth construction:

```ts
const mergedSchema = withInternalTables(options.schema)
const { db, driver } = await createDb(mergedSchema, {
  ...config.database,
  dialect,
})
const userDb = db as unknown as DbFor<TSchema>
const auth = createAuth(
  db,
  withEmailAuthDefaults(config.auth, email, Boolean(options.email)),
  dialect,
)
```

(Update the comment above `userDb`: it now explains the cast produces the per-dialect user-facing type.)

6. Provision internals gains the new fields:

```ts
;(app as WithProvisionInternals)[PROVISION_INTERNALS] = {
  db,
  schema: mergedSchema,
  databaseUrl: config.database.url,
  migrationsFolder: config.database.migrations,
  dialect,
  driver,
}
```

7. **Delete** the bottom re-export block:

```ts
// DELETE these lines entirely:
export {
  sqliteTable,
  integer,
  text,
  real,
  blob,
  numeric,
  foreignKey,
} from 'drizzle-orm/sqlite-core'
export { eq, and, or, not, gt, gte, lt, lte, desc, asc, sql } from 'drizzle-orm'
```

- [ ] **Step 8: Update every caller in tests**

- `src/db.test.ts`: `createDb({ posts }, { url: ':memory:' })` → `const { db } = await createDb({ posts }, { url: ':memory:', dialect: 'sqlite' })`; `db.$client.execute` — `$client` is no longer statically typed on the union return; change to `await db.run(...)`? No — keep it simple: `await (db as { $client: { execute(sql: string): Promise<unknown> } }).$client.execute(...)` or replace the manual DDL with `db.run(sql\`CREATE TABLE ...\`)`using`import { sql } from 'drizzle-orm'`. Use the `db.run(sql\`…\`)`form (LibSQLDatabase has`.run`).
- `src/crud.test.ts:41`: `db = createDb(...)` → `;({ db } = await createDb({ posts }, { url: ':memory:', dialect: 'sqlite' }))`. The `db` variable's declared type `LibSQLDatabase<{ posts: typeof posts }>` stays valid (`DbFor` resolves to it for a sqlite schema).
- Every `createBunderstack(` call in: `index.test.ts`, `access.integration.test.ts`, `app-env.test.ts`, `auth-email.test.ts`, `infer-client.test.ts`, `trpc-mount.test.ts`, `provision.integration.test.ts`, `storage/multibucket.integration.test.ts`, `packages/bunderstack-query/src/trpc-client.test.ts` — prefix with `await` (make enclosing test callbacks/`beforeAll` async where they aren't). Find them all: `grep -rn "createBunderstack(" src ../bunderstack-query/src`.
- `infer-client.test.ts`: where the value is only used for types, `const app = await createBunderstack({...})` inside an async test still works; if any usage is `ReturnType<typeof createBunderstack>`, wrap in `Awaited<…>`.
- Any test importing removed re-exports (`sqliteTable` etc. **from 'bunderstack'/'./index'**) → import from `drizzle-orm/sqlite-core` / `drizzle-orm` instead. Check: `grep -rn "from './index'" src | grep -v "createBunderstack\|type"`.

- [ ] **Step 9: Run the full suites**

Run: `bun test` (packages/bunderstack) → green.
Run: `bun test --cwd ../bunderstack-query` → green.
Run: `bun test src/db.pg.test.ts` → the new pg tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A packages/bunderstack/src packages/bunderstack-query/src
git commit -m "feat(bunderstack): async multi-driver createDb; async createBunderstack; drop drizzle re-exports"
```

---

### Task 6: Provision on Postgres (push + per-driver migrators)

**Files:**

- Modify: `packages/bunderstack/src/provision.ts`
- Test: `packages/bunderstack/src/provision.pg.integration.test.ts` (new)

**Interfaces:**

- Consumes: `ProvisionInternals.dialect`/`.driver` (Task 5), `detectDialect` (Task 2), `AnyDb`.
- Produces: `provisionSchema(db: AnyDb, schema, options?: { force?: boolean; databaseUrl?: string })` — signature unchanged from Task 5 state; self-detects dialect from `schema`. `provision(app, options?)` unchanged signature.

- [ ] **Step 1: Write the failing tests**

```ts
// src/provision.pg.integration.test.ts
import { test, expect } from 'bun:test'
import { sql } from 'drizzle-orm'
import { bigint, pgTable, serial, text } from 'drizzle-orm/pg-core'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createBunderstack } from './index'
import { provision } from './provision'

const widgets = pgTable('provision_pg_widgets', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }),
})

test('provision pushes a pg schema to PGlite when no migrations exist', async () => {
  const app = await createBunderstack({
    schema: { widgets },
    database: { url: 'memory://', migrations: './does-not-exist-migrations' },
  })

  await provision(app, { force: true })

  const [row] = await app.db.insert(widgets).values({ label: 'ok' }).returning()
  expect(row?.label).toBe('ok')
})

test('provision applies committed pg migrations instead of pushing', async () => {
  const dir = join(
    process.cwd(),
    `.test-pg-migrations-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(join(dir, 'meta'), { recursive: true })
  await writeFile(
    join(dir, '0000_init.sql'),
    'CREATE TABLE migrated_pg_widgets (id integer PRIMARY KEY, label text NOT NULL);',
  )
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        {
          idx: 0,
          version: '7',
          when: Date.now(),
          tag: '0000_init',
          breakpoints: true,
        },
      ],
    }),
  )

  try {
    const app = await createBunderstack({
      schema: { widgets },
      database: { url: 'memory://', migrations: dir },
    })

    await provision(app)

    const migrated = await app.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'migrated_pg_widgets'`)
    expect(migrated.rows.length).toBe(1)
    const pushed = await app.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'provision_pg_widgets'`)
    expect(pushed.rows.length).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/provision.pg.integration.test.ts`
Expected: FAIL — push calls `pushSQLiteSchema` against a pg db / migrate imports the libsql migrator.

- [ ] **Step 3: Rewrite `provision.ts`**

Replace `ensureSqliteFileParent` with a dialect-aware helper and branch push/migrate:

```ts
// src/provision.ts
import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AnyDb, Dialect } from './dialect'

import { detectDialect } from './dialect'
import {
  PROVISION_INTERNALS,
  type WithProvisionInternals,
} from './provision-internals'

/** Create the local backing directory for file-based urls, per dialect. */
async function ensureLocalDataDir(
  url: string,
  dialect: Dialect,
): Promise<void> {
  if (dialect === 'pg') {
    // PGlite data dir: `file:<dir>` or a bare path; server/memory urls need nothing.
    if (/^postgres(ql)?:\/\//.test(url)) return
    const raw = url.startsWith('file:') ? url.slice('file:'.length) : url
    if (raw === ':memory:' || raw.startsWith('memory://')) return
    await mkdir(raw, { recursive: true })
    return
  }
  const match = /^file:(.+)$/.exec(url)
  if (!match) return
  const filePath = match[1]!
  if (filePath === ':memory:') return
  await mkdir(dirname(filePath), { recursive: true })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const DRIZZLE_KIT_HINT =
  '[bunderstack] Schema push requires drizzle-kit, which is not installed.\n' +
  '  Development: run `bun add -d drizzle-kit` — provision() will push schema changes to the database on startup.\n' +
  '  Production: generate migrations locally with `bunx drizzle-kit generate` and commit the folder — provision() applies them without drizzle-kit.'

/** Push the merged schema to the database via drizzle-kit/api. */
export async function provisionSchema<TSchema extends Record<string, unknown>>(
  db: AnyDb,
  schema: TSchema,
  options?: { force?: boolean; databaseUrl?: string },
): Promise<void> {
  const dialect = detectDialect(schema)
  if (options?.databaseUrl) {
    await ensureLocalDataDir(options.databaseUrl, dialect)
  }

  let kit: typeof import('drizzle-kit/api')
  try {
    // Ignore comments keep bundlers (vite/nitro, webpack) from resolving
    // drizzle-kit at build time — this branch only runs in development.
    kit = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ 'drizzle-kit/api'
    )
  } catch (cause) {
    throw new Error(DRIZZLE_KIT_HINT, { cause })
  }

  const result =
    dialect === 'pg'
      ? await kit.pushSchema(schema, db as never)
      : await kit.pushSQLiteSchema(schema, db as never)

  if (result.hasDataLoss && !options?.force) {
    throw new Error(
      '[bunderstack] Schema push would cause data loss. Run `bunx drizzle-kit push` or call provision(app, { force: true }).',
    )
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[bunderstack] ${warning}`)
    }
  }

  if (result.statementsToExecute.length === 0) return

  await result.apply()

  console.log(
    `[bunderstack] provisioned ${result.statementsToExecute.length} schema change(s)`,
  )
}

const MIGRATOR_MODULES = {
  libsql: 'drizzle-orm/libsql/migrator',
  pglite: 'drizzle-orm/pglite/migrator',
  'bun-sql': 'drizzle-orm/bun-sql/migrator',
  'postgres-js': 'drizzle-orm/postgres-js/migrator',
} as const
```

Keep the existing `provision()` doc comment; the body becomes:

```ts
export async function provision(
  app: object,
  options?: { force?: boolean },
): Promise<void> {
  const internals = (app as WithProvisionInternals)[PROVISION_INTERNALS]
  if (!internals) {
    throw new Error(
      '[bunderstack] provision() expects the app returned by createBunderstack().',
    )
  }

  const { db, schema, databaseUrl, migrationsFolder, dialect, driver } =
    internals
  const journal = join(migrationsFolder, 'meta', '_journal.json')

  if (await exists(journal)) {
    await ensureLocalDataDir(databaseUrl, dialect)
    const { migrate } = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ MIGRATOR_MODULES[driver]
    )) as {
      migrate: (db: never, cfg: { migrationsFolder: string }) => Promise<void>
    }
    await migrate(db as never, { migrationsFolder })
    return
  }

  await provisionSchema(db, schema, { force: options?.force, databaseUrl })
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/provision.pg.integration.test.ts` → PASS.
Run: `bun test` → full suite green (sqlite provision tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/provision.ts src/provision.pg.integration.test.ts
git commit -m "feat(bunderstack): provision pushes and migrates on Postgres"
```

---

### Task 7: Case-insensitive search on pg (`ilike`) + CRUD parity suite

**Files:**

- Modify: `packages/bunderstack/src/list-query.ts` (buildSearchWhere)
- Test: `packages/bunderstack/src/crud.pg.test.ts` (new)

**Interfaces:**

- Consumes: `createDb`, `provisionSchema`, `buildCrudRouter`, `withInternalTables`, `validateAndResolveAccess` — all existing signatures.
- Produces: no API change; `?q=` search is case-insensitive on both dialects.

- [ ] **Step 1: Write the failing parity suite**

```ts
// src/crud.pg.test.ts — CRUD surface parity on PGlite. Mirrors crud.test.ts flows.
import { test, expect, beforeAll } from 'bun:test'
import { bigint, pgTable, serial, text } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'

import { validateAndResolveAccess } from './access'
import { buildCrudRouter } from './crud'
import { createDb } from './db'
import { withInternalTables } from './internal-tables'
import { provisionSchema } from './provision'

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body'),
  authorId: text('authorId'),
  createdAt: bigint('createdAt', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
})

const testAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const userId = headers.get('x-test-user')
      if (!userId) return null
      return { user: { id: userId, email: `${userId}@test.com`, name: 'Test' } }
    },
  },
}

let app: Hono

beforeAll(async () => {
  const merged = withInternalTables({ posts })
  const { db } = await createDb(merged, { url: 'memory://', dialect: 'pg' })
  await provisionSchema(db, merged, { force: true })
  const access = validateAndResolveAccess(
    { posts },
    {
      posts: {
        ownerColumn: 'authorId',
        searchableColumns: ['title', 'body'],
        filterableColumns: ['authorId'],
        sortableColumns: ['createdAt', 'id'],
        defaultSort: { column: 'createdAt', order: 'desc' },
      },
    },
  )
  app = new Hono()
  app.route(
    '/api',
    buildCrudRouter({ posts }, db, {
      auth: testAuth,
      access,
      idempotency: true,
    }),
  )
})

const asUser = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json',
  'x-test-user': 'user-1',
  ...extra,
})

test('POST creates a record on Postgres', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: asUser(),
    body: JSON.stringify({ title: 'First Post' }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.title).toBe('First Post')
  expect(body.authorId).toBe('user-1')
})

test('GET list returns rows', async () => {
  const res = await app.request('/api/posts', { headers: asUser() })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.data.length).toBeGreaterThanOrEqual(1)
})

test('search is case-insensitive on Postgres', async () => {
  await app.request('/api/posts', {
    method: 'POST',
    headers: asUser(),
    body: JSON.stringify({ title: 'UniqueSearchTarget' }),
  })
  const res = await app.request('/api/posts?q=uniquesearchtarget', {
    headers: asUser(),
  })
  const body = await res.json()
  expect(body.data.length).toBe(1)
  expect(body.data[0].title).toBe('UniqueSearchTarget')
})

test('PATCH updates and DELETE removes on Postgres', async () => {
  const created = await (
    await app.request('/api/posts', {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ title: 'To Edit' }),
    })
  ).json()
  const patched = await app.request(`/api/posts/${created.id}`, {
    method: 'PATCH',
    headers: asUser(),
    body: JSON.stringify({ title: 'Edited' }),
  })
  expect(patched.status).toBe(200)
  const deleted = await app.request(`/api/posts/${created.id}`, {
    method: 'DELETE',
    headers: asUser(),
  })
  expect(deleted.status).toBe(200)
  const gone = await app.request(`/api/posts/${created.id}`, {
    headers: asUser(),
  })
  expect(gone.status).toBe(404)
})

test('idempotency replays the original response on Postgres', async () => {
  const headers = asUser({ 'Idempotency-Key': 'pg-key-1' })
  const body = JSON.stringify({ title: 'Idem' })
  const first = await app.request('/api/posts', {
    method: 'POST',
    headers,
    body,
  })
  const second = await app.request('/api/posts', {
    method: 'POST',
    headers,
    body,
  })
  expect(second.status).toBe(first.status)
  expect(await second.json()).toEqual(await first.json())
})
```

Adjust assertion shapes (`body.data` vs raw array, status codes) to whatever `crud.test.ts` asserts for the same routes — the sqlite file is the source of truth for response shapes; mirror it exactly.

- [ ] **Step 2: Run to verify the search test fails**

Run: `bun test src/crud.pg.test.ts`
Expected: the case-insensitive search test FAILS (pg `LIKE` is case-sensitive); the rest should pass — if others fail, fix those first (they indicate real dialect bugs, e.g. quoting of the camelCase `"authorId"` column).

- [ ] **Step 3: Switch `buildSearchWhere` to `ilike` on pg**

In `list-query.ts`: add `ilike` and `is` to the `drizzle-orm` import, add `import { PgTable } from 'drizzle-orm/pg-core'`, and change the map line:

```ts
const likeOp = is(table, PgTable) ? ilike : like
const conditions = searchableColumns
  .filter((name) => name in columns)
  .map((name) => likeOp(columns[name]!, pattern))
```

- [ ] **Step 4: Run tests**

Run: `bun test src/crud.pg.test.ts` → all pass.
Run: `bun test` → full suite green (sqlite search still uses `like`).

- [ ] **Step 5: Commit**

```bash
git add src/list-query.ts src/crud.pg.test.ts
git commit -m "feat(bunderstack): CRUD parity on Postgres; case-insensitive search via ilike"
```

---

### Task 8: Real-Postgres (Bun.sql) gated integration test

**Files:**

- Test: `packages/bunderstack/src/bunsql.integration.test.ts` (new)

**Interfaces:**

- Consumes: `createBunderstack`, `provision` — existing signatures. Env var `TEST_POSTGRES_URL` gates execution.

- [ ] **Step 1: Write the gated test**

```ts
// src/bunsql.integration.test.ts — end-to-end against a real Postgres server.
// Skipped unless TEST_POSTGRES_URL is set, e.g.:
//   TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres bun test src/bunsql.integration.test.ts
import { test, expect } from 'bun:test'
import { sql } from 'drizzle-orm'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

import { createBunderstack } from './index'
import { provision } from './provision'

const url = process.env.TEST_POSTGRES_URL

const widgets = pgTable('bunsql_it_widgets', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
})

test.skipIf(!url)(
  'createBunderstack + provision work against real Postgres via Bun.sql',
  async () => {
    const app = await createBunderstack({
      schema: { widgets },
      database: { url: url!, migrations: './does-not-exist-migrations' },
    })
    // Clean slate: drop leftovers from previous runs before pushing.
    await app.db.execute(sql`DROP TABLE IF EXISTS bunsql_it_widgets`)
    await provision(app, { force: true })

    const [row] = await app.db
      .insert(widgets)
      .values({ label: 'real-pg' })
      .returning()
    expect(row?.label).toBe('real-pg')

    await app.db.execute(sql`DROP TABLE IF EXISTS bunsql_it_widgets`)
  },
)
```

- [ ] **Step 2: Verify skip and (if available) live behavior**

Run: `bun test src/bunsql.integration.test.ts`
Expected: 1 skip (no `TEST_POSTGRES_URL` locally). If a local Postgres is available, also run with the env var set and expect PASS. Do not add Docker/CI plumbing — out of scope.

- [ ] **Step 3: Commit**

```bash
git add src/bunsql.integration.test.ts
git commit -m "test(bunderstack): gated real-Postgres integration test via Bun.sql"
```

---

### Task 9: `bunderstack/typeid/pg` and `bunderstack/schema/pg` subpaths

**Files:**

- Create: `packages/bunderstack/src/typeid-pg.ts`
- Create: `packages/bunderstack/src/schema-export-pg.ts`
- Modify: `packages/bunderstack/src/typeid.ts` (export `isValidPrefix`)
- Test: `packages/bunderstack/src/typeid-pg.test.ts` (new)

(The `exports` map entries were added in Task 1.)

**Interfaces:**

- Consumes: `isValidPrefix`, `TypeId`, `generate`, `parse`, `asTypeId`, `encode`, `decode` from `./typeid` (all but `isValidPrefix` already exported; check `encode`/`decode` exports — they are).
- Produces: `typeid<P>(prefix)` pg column builder; `bunderstack/schema/pg` exporting `bunderstackFiles`/`bunderstackIdempotency` (pg twins under the sqlite names, mirroring `bunderstack/schema`).

- [ ] **Step 1: Write the failing test**

```ts
// src/typeid-pg.test.ts
import { test, expect } from 'bun:test'
import { is } from 'drizzle-orm'
import { PgTable, pgTable } from 'drizzle-orm/pg-core'

import { typeid as typeidPg } from './typeid-pg'
import { generate } from './typeid'

test('pg typeid column builds into a pgTable and generates branded ids', () => {
  const table = pgTable('tid_things', {
    id: typeidPg('thing')
      .primaryKey()
      .$defaultFn(() => generate('thing')),
  })
  expect(is(table, PgTable)).toBe(true)
  const id = generate('thing')
  expect(id.startsWith('thing_')).toBe(true)
})

test('pg typeid rejects invalid prefixes', () => {
  expect(() => typeidPg('Bad_Prefix!')).toThrow(/Invalid typeid prefix/)
})

test('schema/pg exports the pg twins under the sqlite names', async () => {
  const mod = await import('./schema-export-pg')
  expect(is(mod.bunderstackFiles, PgTable)).toBe(true)
  expect(is(mod.bunderstackIdempotency, PgTable)).toBe(true)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/typeid-pg.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Export `isValidPrefix` from `typeid.ts`**

Find the `isValidPrefix` function/const in `typeid.ts` and add `export` to it (keep its doc comment).

- [ ] **Step 4: Create the two modules**

```ts
// src/typeid-pg.ts — Postgres twin of the typeid column builder. The codec
// (generate/parse/encode/decode) is dialect-neutral and lives in ./typeid;
// only the drizzle customType wrapper differs.
import { customType } from 'drizzle-orm/pg-core'

import { isValidPrefix, type TypeId } from './typeid'

/**
 * Drizzle column builder for a branded TypeID text value (Postgres). Stores a
 * plain `text` column so drizzle-kit migrations and `$inferSelect` work
 * unchanged.
 *
 *   id: typeid('post').primaryKey().$defaultFn(() => generate('post'))
 */
export function typeid<P extends string>(prefix: P) {
  if (!isValidPrefix(prefix))
    throw new Error(`Invalid typeid prefix: "${prefix}"`)
  return customType<{ data: TypeId<P>; driverData: string }>({
    dataType: () => 'text',
  })()
}

export { generate, parse, asTypeId, encode, decode } from './typeid'
export type { TypeId } from './typeid'
```

```ts
// src/schema-export-pg.ts — pg twins under the same names bunderstack/schema
// uses, so `export * from 'bunderstack/schema/pg'` mirrors the sqlite setup.
export {
  bunderstackFilesPg as bunderstackFiles,
  bunderstackIdempotencyPg as bunderstackIdempotency,
} from './internal-tables-pg'
```

- [ ] **Step 5: Run tests**

Run: `bun test src/typeid-pg.test.ts` → PASS. Then `bun test` → green.

- [ ] **Step 6: Commit**

```bash
git add src/typeid.ts src/typeid-pg.ts src/schema-export-pg.ts src/typeid-pg.test.ts
git commit -m "feat(bunderstack): typeid/pg and schema/pg subpath exports"
```

---

### Task 10: Examples and sibling packages sweep

Every example must compile against the new surface: `await createBunderstack`, drizzle imports from drizzle-orm, explicit `drizzle-orm` + `@libsql/client` deps.

**Files:**

- Modify: `examples/{todo,kanban-tanstack,kanban-solid-1.9,twitter-tanstack,twitter-db-tanstack,tldraw,nextjs,standalone}/src/bunderstack.ts` (or equivalent entry; check each exists), `*/src/schema.ts`, `*/package.json`; `examples/twitter-tanstack/scripts/seed.ts`, `examples/twitter-db-tanstack/scripts/seed.ts`
- Modify: `packages/bunderstack-query/package.json`, `packages/bunderstack-start/package.json`, `packages/bunderstack-sync/package.json` (only if they reference drizzle-orm or construct apps — check first)

**Interfaces:**

- Consumes: async `createBunderstack` (Task 5), removed root re-exports.

- [ ] **Step 1: Enumerate all affected sites**

```bash
grep -rn "createBunderstack(" examples packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "packages/bunderstack/src"
grep -rn "from 'bunderstack'" examples --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -E "sqliteTable|integer|text|real|blob|numeric|foreignKey|\beq\b|\band\b|\bor\b|\bnot\b|\bgt\b|\bgte\b|\blt\b|\blte\b|\bdesc\b|\basc\b|\bsql\b"
```

- [ ] **Step 2: Update each schema file**

Pattern (e.g. `examples/todo/src/schema.ts` line 1):

```ts
// Before:
import { sqliteTable, integer, text, typeid, generateTypeId } from 'bunderstack'
// After:
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { typeid, generate as generateTypeId } from 'bunderstack/typeid'
```

(`typeid` and `generateTypeId` remain exported from the bunderstack root too — prefer the `bunderstack/typeid` subpath in examples for symmetry with the new `typeid/pg`. Operator imports (`eq`, `and`, …) from 'bunderstack' become `from 'drizzle-orm'`.)

- [ ] **Step 3: Update each `bunderstack.ts` / seed script**

`const app = createBunderstack(` / `export const app = createBunderstack(` → add `await`. Seed scripts that build their own app instance get `await` too (they're top-level in Bun scripts — fine).

- [ ] **Step 4: Add explicit deps to every example `package.json`**

In each example's `dependencies`:

```json
    "@libsql/client": "^0.14.0",
    "drizzle-orm": "^0.45.0",
```

For `packages/bunderstack-{query,start,sync}`: run `grep -rn "drizzle-orm\|@libsql" packages/bunderstack-query packages/bunderstack-start packages/bunderstack-sync --include="*.ts" --include="package.json" | grep -v node_modules`. Where a package imports drizzle-orm directly, add it to that package's `peerDependencies` (same `^0.45.0`); if it only uses bunderstack's public types, no change.

- [ ] **Step 5: Install and verify**

Run (repo root): `bun install`
Run (repo root): `bun run test` — all four package suites green.
Spot-check one example typechecks: `cd examples/todo && bunx tsc --noEmit` (compare against the pre-existing-failures baseline: Start-example vite build and tldraw tsc errors were already broken on main — anything beyond that baseline must be fixed).

- [ ] **Step 6: Commit**

```bash
git add examples packages/*/package.json bun.lock
git commit -m "refactor(examples): await createBunderstack; import drizzle builders from drizzle-orm"
```

---

### Task 11: Documentation

**Files:**

- Modify: `website/content/docs/getting-started.mdx`
- Modify: `website/content/docs/configuration.mdx`
- Modify: `website/content/docs/framework-portability.mdx`
- Modify: `website/content/docs/api-reference.mdx`
- Modify: `README.md`, `packages/bunderstack/README.md` (if it shows `createBunderstack`), `examples/README.md`

- [ ] **Step 1: Sweep every `createBunderstack(` snippet to `await createBunderstack(`**

```bash
grep -rln "createBunderstack(" website README.md examples/README.md | grep -v node_modules
```

Update each snippet (Next.js lazy-singleton snippets: `_app = createBunderstack(` → `_app = await createBunderstack(`).

- [ ] **Step 2: Add the Postgres section to `getting-started.mdx`**

Insert after the existing database/getting-started material:

````mdx
## Using PostgreSQL

Bunderstack infers the database dialect from your schema: define tables with
`pgTable` and the whole stack — CRUD, auth, storage metadata, provisioning —
switches to Postgres.

\`\`\`ts
// schema.ts
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const todos = pgTable('todos', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
\`\`\`

For local development install PGlite — an embedded Postgres that lives in a
local directory, no Docker or server required:

\`\`\`bash
bun add -d @electric-sql/pglite
\`\`\`

With no `DATABASE_URL` set, bunderstack runs PGlite in `./data.pglite`,
creating it on first start. In production, point the same app at a real
Postgres — no code changes:

\`\`\`bash
DATABASE_URL=postgres://user:pass@host/db
\`\`\`

Under Bun the built-in `Bun.sql` driver is used (zero extra packages). On
Node runtimes (e.g. Next.js), install the driver: `npm install postgres`.
\`\`\`

- [ ] **Step 3: Add the URL→engine table and dialect notes to `configuration.mdx`**

```mdx
## Database dialect and DATABASE_URL

The dialect comes from your schema (`sqliteTable` → SQLite, `pgTable` →
Postgres). `DATABASE_URL` selects the engine within the dialect:

| Schema        | `DATABASE_URL`  | Engine                                  |
| ------------- | --------------- | --------------------------------------- |
| `sqliteTable` | unset           | local SQLite file `./data.db`           |
| `sqliteTable` | `file:./app.db` | local SQLite file                       |
| `sqliteTable` | `libsql://…`    | Turso (`DATABASE_AUTH_TOKEN` for auth)  |
| `pgTable`     | unset           | PGlite in `./data.pglite`               |
| `pgTable`     | `file:./pgdata` | PGlite in that directory                |
| `pgTable`     | `memory://`     | PGlite in-memory (tests)                |
| `pgTable`     | `postgres://…`  | Postgres server (Bun.sql / postgres.js) |

A URL that contradicts the schema dialect fails at startup with a clear error.
```
````

Also document the peer-dependency model here (drizzle-orm required; `@libsql/client`, `@electric-sql/pglite`, `postgres` optional — install the one your setup needs; the startup error names the exact command otherwise).

- [ ] **Step 4: `framework-portability.mdx` + `api-reference.mdx`**

- Portability: update all snippets to `await createBunderstack`; add one line to the Next.js section: "On Node runtimes, Postgres uses the `postgres` (postgres.js) driver — `npm install postgres`; under Bun the built-in `Bun.sql` is used automatically." Note that `skipLibCheck: true` (the TS default in most templates) is expected when optional driver packages aren't installed.
- API reference: `createBunderstack` is `async`; document `app.db` as "Drizzle client typed for your schema's dialect (`LibSQLDatabase` / `PgDatabase`)"; add a migration note: the drizzle builder/operator re-exports (`sqliteTable`, `eq`, …) were removed — import from `drizzle-orm` / `drizzle-orm/sqlite-core` / `drizzle-orm/pg-core`; document `bunderstack/schema/pg` and `bunderstack/typeid/pg`.

- [ ] **Step 5: Verify docs build (if website has a build script)**

Run: `cd website && bun run build` — compare failures to baseline (website static build was fixed per 2026-07-02 spec; expect green).

- [ ] **Step 6: Commit**

```bash
git add website README.md examples/README.md packages/bunderstack/README.md
git commit -m "docs: PostgreSQL + PGlite guide, dialect URL table, async createBunderstack"
```

---

### Task 12: Final verification

- [ ] **Step 1: Full test run**

Run (repo root): `bun run test`
Expected: all four package suites green.

- [ ] **Step 2: Fresh-eyes spec check**

Re-read `docs/superpowers/specs/2026-07-16-postgres-pglite-support-design.md` section by section and confirm each requirement maps to landed code (dialect inference, URL table incl. `:memory:` normalization, peer deps, error messages with install hints, async factory, internal-table twins, `ilike`, provision push+migrate, subpaths, docs). Fix any gap found.

- [ ] **Step 3: Manual smoke test (PGlite happy path)**

```bash
cd /tmp && mkdir pg-smoke && cd pg-smoke && bun init -y
bun add bunderstack@file:/Users/kirill/pet-projects/bunderstack/packages/bunderstack drizzle-orm
bun add -d @electric-sql/pglite drizzle-kit
```

```ts
// index.ts
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { createBunderstack } from 'bunderstack'
import { provision } from 'bunderstack/provision'

const todos = pgTable('todos', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
const app = await createBunderstack({ schema: { todos } })
await provision(app)
const [row] = await app.db.insert(todos).values({ title: 'works' }).returning()
console.log('smoke:', row)
```

Run: `bun index.ts` → prints `smoke: { id: 1, title: 'works' }` and creates `./data.pglite/`. Then delete `/tmp/pg-smoke`.

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A && git commit -m "fix(bunderstack): post-verification fixes for postgres support"
```

(Skip if nothing changed.)
