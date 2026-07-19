# PostgreSQL Support (+ PGlite for Local Development)

**Date:** 2026-07-16
**Status:** Approved

## Goal

Bunderstack currently supports one database: SQLite via `@libsql/client` (local
file in dev, Turso in prod). This spec adds PostgreSQL as a second dialect with
the same zero-config local story: PGlite (embedded WASM Postgres in a local
directory) for development, any real Postgres (`postgres://…`) in production —
no Docker, no local server, no code changes between the two.

## Developer experience

No new config keys. The dialect is inferred from the Drizzle schema itself:
tables built with `pgTable` → Postgres, `sqliteTable` → SQLite. A schema mixing
both dialects throws a clear error at `createBunderstack()` time.

```ts
// schema.ts — this alone switches bunderstack to Postgres
import { pgTable, text } from 'drizzle-orm/pg-core'
export const todos = pgTable('todos', { id: text('id').primaryKey() /* … */ })
```

Within the Postgres dialect, `DATABASE_URL` selects the engine:

| `DATABASE_URL` | Engine                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| unset          | PGlite in `./data.pglite` (directory auto-created)                       |
| `file:./path`  | PGlite in that directory                                                 |
| `memory://`    | PGlite in-memory (tests)                                                 |
| `postgres://…` | Real Postgres — `Bun.sql` under Bun, `postgres` (postgres.js) under Node |

Mental model stays the same as SQLite: **no URL / `file:` = local embedded, a
server URL = production**. If the URL scheme contradicts the schema dialect
(e.g. `postgres://` with a sqlite schema), throw with a clear message.

The `DATABASE_URL` default becomes dialect-aware: `file:./data.db` (sqlite,
unchanged) / `file:./data.pglite` (pg).

## Dependencies

- `drizzle-orm` moves from `dependencies` to **required `peerDependencies`**
  (kept as a devDependency for the package's own tests). One copy per project —
  the duplicate-install type-conflict problem disappears, so users import
  `pgTable`/`sqliteTable` directly from `drizzle-orm/pg-core` /
  `drizzle-orm/sqlite-core`. Bun and npm ≥7 auto-install required peers, so
  `bun add bunderstack` still pulls drizzle-orm automatically.
- `@libsql/client` moves to **optional** peerDependencies (only SQLite users
  need it).
- `@electric-sql/pglite` — new **optional** peer (only local pg development
  needs it; keeps its ~10 MB WASM out of sqlite users and pg production
  deploys).
- `postgres` (postgres.js) — new **optional** peer (only pg-on-Node needs it;
  under Bun the built-in `Bun.sql` is used, zero extra packages).

All optional drivers are loaded via dynamic `import()` behind the dialect/URL
branch, with a helpful install-command error when missing — same pattern as the
existing drizzle-kit error in `provision.ts` (including the
`/* @vite-ignore */ /* webpackIgnore: true */` comments so bundlers don't try
to resolve them at build time). Example:

```
[bunderstack] Local Postgres development requires PGlite, which is not installed.
  Run `bun add -d @electric-sql/pglite` — bunderstack will run an embedded
  Postgres in ./data.pglite. In production set DATABASE_URL=postgres://…
  (PGlite is not needed there).
```

The re-exports of `sqliteTable`, column builders, and `foreignKey` from the
`bunderstack` root are **removed** (breaking, acceptable at 0.1.0 pre-publish).
The drizzle operator re-exports (`eq`, `and`, `sql`, …) are removed with them.
Examples and docs are updated to import from drizzle directly.

## Architecture

### Dialect detection (`dialect.ts`, new)

`detectDialect(schema): 'sqlite' | 'pg'` — walk schema values, classify tables
via drizzle's `is(table, PgTable)` / `is(table, SQLiteTable)`. Empty schema
defaults to `'sqlite'` (status quo). Mixed dialects → throw.

### Database factory (`db.ts`)

`createDb` becomes async-capable dispatch on (dialect, url):

- **sqlite** → `@libsql/client` + `drizzle-orm/libsql` (unchanged, but the
  client import becomes dynamic so `@libsql/client` can be an optional peer).
- **pg + `postgres://`** → runtime detect: `typeof Bun !== 'undefined'` →
  `drizzle-orm/bun-sql` with `Bun.sql`; otherwise dynamic-import `postgres`
  (postgres.js) + `drizzle-orm/postgres-js`, with install-hint error.
- **pg + `file:`/unset/`memory://`** → dynamic-import `@electric-sql/pglite` +
  `drizzle-orm/pglite`, `mkdir -p` the data directory first.

**API change: `createBunderstack` becomes `async`.** Optional-peer drivers can
only be loaded with dynamic `import()`, which is asynchronous, so the factory
now returns `Promise<BunderstackApp>`. Callers write
`export const app = await createBunderstack({ … })` — TanStack Start supports
top-level await (the docs already rely on it), and the Next.js pattern is
already an async lazy singleton. The alternative — a sync factory with a
proxy-wrapped `app.db` that queues queries until the driver loads — was
rejected as too magical for an escape-hatch surface that users debug directly.
Breaking, acceptable at 0.1.0 pre-publish; all examples/docs update in the
same change.

### Types

A computed database type replaces the hardcoded `LibSQLDatabase<TSchema>`
everywhere it appears (crud, list-query, trpc ctx, idempotency, storage
modules, `BunderstackApp.db`, provision internals):

```ts
type DbFor<TSchema> =
  DialectOf<TSchema> extends 'pg'
    ? PgDatabase<PgQueryResultHKT, TSchema>
    : LibSQLDatabase<TSchema>
```

where `DialectOf` inspects whether the schema's table values extend `PgTable`.
`app.db` and tRPC `ctx.db` stay fully typed for their dialect. Internal
modules that only need the query builder accept the union and use the common
surface (`select/insert/update/delete/returning/onConflictDoUpdate` — verified
present and compatible in both dialects).

### Internal tables (`internal-tables.ts`)

Add pg twins of `bunderstack_file_meta` and `_bunderstack_idempotency` built
with `pgTable` (timestamps stay integer-ms: `bigint({ mode: 'number' })`).
`withInternalTables` picks the set matching the detected dialect. The
reserved-name check stays dialect-agnostic.

### Subpath exports

`drizzle.config.ts` and schema files are static — they can't runtime-detect a
dialect — so dialect-specific artifacts get explicit subpaths:

- `bunderstack/schema` — sqlite internal tables (unchanged)
- `bunderstack/schema/pg` — pg internal tables (new)
- `bunderstack/typeid` — sqlite `customType` column (unchanged)
- `bunderstack/typeid/pg` — pg `customType` column (new; the codec logic is
  shared, only the `drizzle-orm/pg-core` `customType` wrapper differs)

### Auth (`auth.ts`)

`drizzleAdapter(db, { provider })` with `provider: 'sqlite' | 'pg'` from the
detected dialect.

### Provision (`provision.ts`)

Same mode switch (migrations journal exists → migrate; else → push), branched
per driver:

- **migrate**: `drizzle-orm/libsql/migrator` | `drizzle-orm/pglite/migrator` |
  `drizzle-orm/bun-sql/migrator` | `drizzle-orm/postgres-js/migrator`, chosen
  by the driver actually in use (recorded in provision internals).
- **push**: `pushSQLiteSchema` | `pushSchema` (pg) from `drizzle-kit/api`.
- **local data dir**: PGlite gets the same treatment as the sqlite `file:`
  parent-dir creation (`mkdir -p` of the data directory).

### Behavioral compatibility

- List search (`?q=`): `like` is case-insensitive in SQLite but case-sensitive
  in Postgres. On pg, use `ilike` so search behaves identically across
  dialects.
- Everything else in crud/list-query/scope/idempotency/storage/realtime is
  dialect-neutral drizzle query-builder code (audited; no raw SQL, no
  sqlite-specific functions).

## Error handling

- Mixed-dialect schema → throw at `createBunderstack()` with both table names.
- URL/dialect contradiction (`postgres://` + sqlite schema, `libsql:`/`turso`
  URL + pg schema) → throw with expected forms.
- Missing optional driver package → throw with the exact `bun add` command and
  a one-line explanation of when the package is needed.

## Testing

- All existing sqlite tests stay green, untouched.
- CRUD / access / list-query / idempotency / storage-meta / provision test
  suites get a second parameterized run against PGlite `memory://` — the full
  framework surface is exercised on both dialects in plain `bun test` with no
  external Postgres.
- New unit tests: dialect detection (sqlite / pg / mixed / empty), URL→engine
  dispatch (including contradiction errors), missing-package error messages.
- Real-Postgres (`Bun.sql`) path is covered by an integration test gated on a
  `TEST_POSTGRES_URL` env var (skipped when unset), mirroring how other
  integration tests in the repo work.

## Documentation

- Getting-started: a Postgres branch — pg schema + `bun add -d
@electric-sql/pglite`, and the prod `DATABASE_URL=postgres://…` handoff.
- Configuration: the URL→engine table from this spec.
- Framework-portability: note the Node fallback driver (`postgres`).
- Migration note for the removed root re-exports (import from drizzle-orm
  directly).

## Out of scope

- Converting an existing example app to Postgres (follow-up task).
- MySQL or any third dialect.
- Multiple databases / dialects in one app.
- Postgres-specific features (RLS, LISTEN/NOTIFY-based realtime, jsonb
  columns) — realtime stays on the existing broker model.
