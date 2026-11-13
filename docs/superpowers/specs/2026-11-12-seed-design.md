# Seeding a database

**Date:** 2026-11-12

Status: built 2026-11-13, released as 0.33.0. Written together with
Bunderhost's `docs/superpowers/specs/2026-11-12-server-database-design.md`.
What was built differs from the proposal below in a few places; they are
listed under [What was built](#what-was-built), and the proposal is kept as
it was written.

## Goal

An application describes, in code, the data an empty database should start
with. The same description serves local development and a preview
environment, so a preview does not need a copy of production.

A seed is preferred over anonymising a copy of production. An anonymiser
leaks every new column until someone remembers to mask it; a seed contains
only what was written into it.

## Rules

- **Never in production.** Nothing in Bunderstack runs a seed unless it is
  told to, and a host must never tell a production environment to.
- **Once per database.** A seeded database is not seeded again by a restart or
  a redeploy.
- **It matches the schema or the build fails.** A seed that no longer fits the
  tables is caught when the blueprint is generated, not in a preview.

## Declaration

```ts
// src/bunderstack.ts
export const backend = bunderstack({
  schema,
  database: {
    adapter: libsql(),
    migrations: './migrations',
    seed: () => import('./seed'),
  },
})
```

```ts
// src/seed.ts
import { defineSeed } from 'bunderstack/seed'
import { backend } from './bunderstack'

export default defineSeed(backend, async ({ db, schema, storage }) => {
  const [ada] = await db
    .insert(schema.users)
    .values({ name: 'Ada', email: 'ada@example.com' })
    .returning()
  await db.insert(schema.orders).values({ userId: ada.id, total: 4200 })
})
```

- `seed` is a lazy import, so a production process never loads the module or
  whatever it depends on (a data generator, fixture files).
- `db` and `schema` are the application's own, so the seed is type-checked
  against the tables like any other code.
- `storage` is there because rows often point at files.
- Users are created through the same `db`; a helper for a user with a
  password comes later if applications ask for it.

## When it runs

At start, after migrations are confirmed and before the server listens, when
both hold:

1. `BUNDERSTACK_SEED` is `1`;
2. the system table `_bunderstack_seed` has no row.

The seed runs in one transaction with the insert into `_bunderstack_seed`
(the time and the application version). If it throws, nothing is kept and the
process exits with the error, so a broken seed fails the deployment where it
is visible.

Locally, `bun dev` sets `BUNDERSTACK_SEED=1` when the application declares a
seed, so a fresh local database comes up with data. `bunderstack seed` runs it
by hand; `bunderstack seed --reset` empties the application's tables first and
refuses to run against a URL that is not a local file.

## Checked at build time

`bunderstack blueprint` (the step that writes `bunderstack.blueprint.yaml`)
creates a temporary SQLite database, applies the application's migrations, and
runs the seed against it. A failure stops the command with the seed's error.
This is what makes "the seed fits the schema" a property of the commit.

## Blueprint

The host needs to know that a seed exists, to offer "seeded" as a way to start
a preview. `resources.database` gains one optional field:

```yaml
resources:
  database:
    seed: true
```

The manifest schema is strict, so this is manifest version 5, and the order of
release matters: Bunderhost accepts version 5 first, then Bunderstack starts
writing it. A host that does not know the field never sets `BUNDERSTACK_SEED`,
and the application starts with an empty database.

## What the host does

Described in Bunderhost's spec. In short: a project setting chooses how a
preview's data starts (a copy of production, empty, or seeded); for `seeded`
the host creates an empty database and bucket and passes
`BUNDERSTACK_SEED=1` to that preview. A production environment never receives
the variable, and a test on the host's side holds that.

## Open

- Whether a seed may read the environment (to make an admin user from
  `SEED_ADMIN_EMAIL`, for instance). Proposed: yes, through the validated
  `env`, like every other callback.
- Postgres: the build-time check uses SQLite today; a `pg` application needs a
  database to check against.

## What was built

`src/seed.ts` (`defineSeed`, the `bunderstack/seed` entry),
`src/seed-runtime.ts` (when and how it runs), `src/seed-command.ts` (the CLI
command and the build-time check), `_bunderstack_seed` in the system tables.
User documentation: `website/content/docs/seeding.mdx`.

Where it differs from the proposal:

- **The slot is typed as a module nobody has looked into.**
  `seed: () => import('./seed')` with `defineSeed(backend, ...)` in that
  module is a cycle if the slot names the module's export: the backend's type
  would depend on the seed's, which depends on the backend's (TS7022, checked
  with the compiler). `database.seed` is `() => Promise<unknown>`, and what
  the module exports is checked when it is loaded. The seed itself is fully
  typed from the backend.
- **The context is `{ db, schema, env }`, without `storage`.** `db` is the
  transaction. Storage writes its file records through the application's own
  connection, outside that transaction: they would not be undone, and on
  SQLite they wait for a lock the seed holds. Files in a seed are not built.
  The open question about the environment is settled: the seed gets `env`.
- **It runs inside `provision(app)`**, both entries, after the schema is in
  place. Bunderstack has no moment "before the server listens" of its own:
  the framework's server listens, and `provision` is the one call every
  application makes at start.
- **Nothing sets `BUNDERSTACK_SEED` for local development but the
  application's own dev script.** Bunderstack has no dev command, and
  inferring "this is development" from `NODE_ENV` or a local database file
  would seed the production of anyone who self-hosts without `NODE_ENV`. The
  template's `dev` script starts with the variable.
- **`bunderstack seed` is for a local database only**, with or without
  `--reset`. A remote one is seeded by its host.
- **The manifest stays version 4.** The blueprint schema keeps what it does
  not know (`open()` in `blueprint.ts`), so `resources.database.seed` is an
  optional field, an older host ignores it, and there is no order of release
  to keep.
- **The build-time check starts the application as `backend.test()` does**,
  on a throwaway database from the adapter's own testing strategy, with the
  committed migrations (or a schema push when there are none). So it covers
  PGlite too. An adapter that needs a server (`bunSql`, `postgresJs`) has no
  throwaway database: the check is skipped and the command says so.
- **Added:** `backend.test({ seed: true })`.

Measured, and why the code is the way it is:

- The libSQL client hands its connection to a transaction and opens another
  afterwards. For `:memory:` that is another, empty database: after
  `db.transaction(...)` the application had lost its tables. On a local
  SQLite database (either driver) the seed's transaction is therefore opened
  by hand on the application's own connection (`BEGIN IMMEDIATE`), and a
  transaction inside the seed becomes a savepoint. A remote database and
  Postgres use the driver's transaction.
- Against sqld 0.24.32 over HTTP: 500 rows one statement each 65 ms, 20 000
  rows a thousand a statement 54 ms; a failing seed leaves no rows and no
  mark. A transaction with a statement every second ran 12 s untouched. One
  with nothing sent for 12 s ended with `STREAM_EXPIRED`. One that had run
  5 s while another connection waited to write ended with
  `TRANSACTION_TIMEOUT`, and the waiting write went through. `SeedFailedError`
  recognises both and says to insert in batches.

Still open: files in a seed; a helper for a user with a password (the docs
show the two inserts and Better Auth's `hashPassword`); a check for
server-backed Postgres adapters.
