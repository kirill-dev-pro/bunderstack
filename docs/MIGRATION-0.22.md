# Bunderstack 0.21.x → 0.22.0 — what changed and how to adapt

Bunderstack 0.22 splits the backend into a pure **declaration** and an explicit **runtime**, flattens every subpath export to a single segment, and adds a first-class testing fixture.

---

## The one-paragraph summary

Two changes need edits in your code. `createBunderstack(config)` becomes synchronous `bunderstack(config)`, which returns a declaration you start explicitly with `await backend.start()`. And every two-segment subpath is now one segment — `bunderstack/database/libsql` becomes `bunderstack/libsql`, `bunderstack/client/react` becomes `bunderstack/client-react`. Both are mechanical. Everything else is additive: `backend.manifest` reads static metadata without touching a database, `bunderstack blueprint` no longer needs `BUNDERSTACK_INTROSPECT`, and `backend.test()` gives you an isolated fixture with a real database, captured email, and deterministic jobs.

---

# What Changed

## 1. Flat Subpath Exports (0.22)

Every subpath export is now a single segment. Nothing moved inside the package — only the names in `exports` changed.

### Import Subpaths Mapping

| Previous Import (0.21)             | New Import (0.22)           | Purpose                               |
| ---------------------------------- | --------------------------- | ------------------------------------- |
| `bunderstack/database/libsql`      | `bunderstack/libsql`        | libSQL / SQLite adapter               |
| `bunderstack/database/bun-sql`     | `bunderstack/bun-sql`       | `Bun.sql` Postgres adapter            |
| `bunderstack/database/pglite`      | `bunderstack/pglite`        | PGlite adapter                        |
| `bunderstack/database/postgres-js` | `bunderstack/postgres-js`   | postgres.js adapter                   |
| `bunderstack/client/rest`          | `bunderstack/client-rest`   | Type-safe REST client                 |
| `bunderstack/client/react`         | `bunderstack/client-react`  | React LiveView hook                   |
| `bunderstack/client/solid`         | `bunderstack/client-solid`  | Solid LiveView primitive              |
| `bunderstack/client/svelte`        | `bunderstack/client-svelte` | Svelte LiveView store                 |
| `bunderstack/client/vue`           | `bunderstack/client-vue`    | Vue LiveView composable               |
| `bunderstack/query/react`          | `bunderstack/query-react`   | React query helpers                   |
| `bunderstack/start/auth`           | `bunderstack/start-auth`    | Better Auth client for TanStack Start |
| `bunderstack/schema/pg`            | `bunderstack/schema-pg`     | Internal tables, Postgres dialect     |
| `bunderstack/typeid/pg`            | `bunderstack/typeid-pg`     | TypeID column, Postgres dialect       |
| `bunderstack/email/smtp`           | `bunderstack/email-smtp`    | SMTP email adapter                    |

Single-segment roots are unchanged: `bunderstack`, `bunderstack/client`, `bunderstack/query`, `bunderstack/sync`, `bunderstack/start`, `bunderstack/schema`, `bunderstack/typeid`, `bunderstack/testing`, `bunderstack/provision`, `bunderstack/access`, `bunderstack/env`, `bunderstack/blueprint`, `bunderstack/cron`, `bunderstack/live`, `bunderstack/api`, `bunderstack/codegen`.

### Why

TypeScript's auto-import completion names a subpath item relative to the package root, but sets the replacement range from the start of the whole specifier. For a two-segment subpath the two disagree: accepting `database/libsql` replaced `bunderstack/database/lib` and produced `from 'database/libsql'` — a broken import that had to be undone by hand. The item carries no `insertText`, so an editor has nothing correct to apply. Single-segment names get the correct range, so completion inserts what you picked.

This is a defect in TypeScript itself, reproducible on 5.4 through 7.0 and on any package with nested `exports`. Flat names avoid it rather than fix it.

### Rewriting your imports

```sh
grep -rl "bunderstack/\(database\|client\|query\|start\|schema\|typeid\|email\)/" src \
  | xargs sed -i '' \
    -e 's|bunderstack/database/|bunderstack/|g' \
    -e 's|bunderstack/client/rest|bunderstack/client-rest|g' \
    -e 's|bunderstack/client/react|bunderstack/client-react|g' \
    -e 's|bunderstack/client/solid|bunderstack/client-solid|g' \
    -e 's|bunderstack/client/svelte|bunderstack/client-svelte|g' \
    -e 's|bunderstack/client/vue|bunderstack/client-vue|g' \
    -e 's|bunderstack/query/react|bunderstack/query-react|g' \
    -e 's|bunderstack/start/auth|bunderstack/start-auth|g' \
    -e 's|bunderstack/schema/pg|bunderstack/schema-pg|g' \
    -e 's|bunderstack/typeid/pg|bunderstack/typeid-pg|g' \
    -e 's|bunderstack/email/smtp|bunderstack/email-smtp|g'
```

On Linux use `sed -i` without the empty argument. Anything missed fails at typecheck as an unresolved module, so there is no silent breakage.

---

## 2. Declaration and Runtime Are Separate (0.22)

`createBunderstack()` did two jobs at once: it described the application and it connected to the database, read `process.env`, and started workers. Those are now two steps.

### Before (0.21)

```ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'

export const app = await createBunderstack({
  schema,
  access,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
  auth: { secret: process.env.AUTH_SECRET! },
  realtime: true,
  api,
})

export type App = typeof app
```

### After (0.22)

```ts
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'

export const backend = bunderstack({
  schema,
  access,
  database: { adapter: libsql(), url: 'file:./data.db' },
  auth: { secret: process.env.AUTH_SECRET! },
  realtime: true,
  api,
})

export const app = await backend.start()

export type App = typeof app
```

`bunderstack(config)` is synchronous and does no I/O. It returns a declaration carrying `backend.manifest` — the static metadata for tables, jobs, routes, and env vars — which you can read without a database. `backend.start()` is the only call that connects, migrates, and starts workers.

If your entry module was a factory (`export async function createApp(options)`) that existed only so tests could pass a different database URL, delete it: declare `backend` once at module scope and use `backend.test()` for isolation. See section 4.

### Startup environment

`backend.start()` with no argument reads `process.env`, as before. Pass `env` when you want a different one, and it becomes the exclusive source — it is never merged with `process.env`:

```ts
// src/worker.ts
import { backend } from './bunderstack/backend'

const app = await backend.start({
  env: { ...process.env, BUNDERSTACK_ROLE: 'worker' },
})
await app.runWorker()
```

### Manifest

`manifest` is a property of the declaration, not of the started app. Replace `app.manifest` with `backend.manifest`. Code that only inspects metadata no longer needs to start anything.

---

## 3. Blueprint Generation Without a Runtime (0.22)

`bunderstack blueprint` imports your declaration and reads `backend.manifest` directly. It no longer boots the application, and `BUNDERSTACK_INTROSPECT` is gone.

```sh
bunx bunderstack blueprint
```

Remove `BUNDERSTACK_INTROSPECT=1` from any script, Dockerfile, or CI step that generated a blueprint. Keep import-time side effects out of the declaration's module graph — the rule is unchanged, but the failure mode is now a plain import error instead of a hang.

---

## 4. Testing Fixtures (`bunderstack/testing`, 0.22, additive)

`backend.test()` builds an isolated runtime per test: its own temporary database with your migrations applied, in-memory email, isolated storage, forced in-memory realtime, and a job runner with no sleeps. The fixture is `AsyncDisposable`, so `await using` tears it down at the end of the block.

```ts
import { expect, test } from 'bun:test'
import { backend } from './bunderstack'

test('posts procedure works', async () => {
  await using fixture = await backend.test({
    database: { mode: 'temporary', schema: 'migrations' },
  })

  const identity = await fixture.auth.signUpEmail({
    email: 'alice@example.com',
    name: 'Alice',
  })
  const client = fixture.client(identity)

  const result = await client.posts.create({ title: 'First post' })
  expect(result.title).toBe('First post')

  await fixture.jobs.runUntilIdle()
  expect(fixture.email.sent).toHaveLength(1)
})
```

The fixture gives you `fixture.app` (the runtime), `fixture.auth` (`signUpEmail()` through the real Better Auth handler, or `mockSession()`), `fixture.client(identity?)` (a typed in-process oRPC client), `fixture.jobs` (`runNext()`, `runUntilIdle()`), `fixture.email.sent`, and `fixture.storage.read(key)`.

### 0.22.1: reusable fixture configuration

If many tests repeat the same environment, database mode, and seed setup, define
them once. Overrides are deep-merged for `env` and `database`:

```ts
export const createFixture = backend.test.configure({
  env: { FEATURE_FLAG: 'enabled' },
  database: { mode: 'temporary', schema: 'migrations' },
  setup: async (fixture) => {
    const identity = fixture.auth.mockSession({
      id: 'test-user',
      email: 'test@example.com',
      name: 'Test User',
    })
    return { identity, client: fixture.client(identity) }
  },
})

test('uses the shared setup', async () => {
  await using fixture = await createFixture()
  await fixture.context.client.posts.list({})
})
```

Use `fixture.defer(cleanup)` for resources created by setup. It runs in LIFO order
before the application closes. Fixtures capture Bunderstack runtime logs by default
in `fixture.logs`; select `logs: 'inherit'` or `logs: 'silent'` when configuring the
factory. Auth tests can use `signInEmail()`, `getSession()`, `signOut()`, and
`verifyEmail()`. Queue assertions can inspect normalized rows with
`fixture.jobs.inspect()`, `.pending()`, and `.failed()`, filtered by job `name` or
`dedupeKey`.

Nothing here is required to upgrade. It replaces hand-rolled harnesses that spun up a second app against a scratch database file.

---

## 5. Migration Checklist

1. **Update `package.json`**: set `"bunderstack": "^0.22.1"`, then `bun install`.
2. **Rewrite subpath imports** with the `sed` command in section 1, or accept the new names from your editor's auto-import — it now inserts them correctly.
3. **Split the declaration from the runtime**:
   - `createBunderstack({...})` → `bunderstack({...})`, assigned to `backend`.
   - Add `export const app = await backend.start()`.
   - Drop `await` from the declaration; it is synchronous.
   - Replace `app.manifest` with `backend.manifest`.
   - Delete any `createApp()` factory that existed only for test isolation.
4. **Drop `BUNDERSTACK_INTROSPECT`** from scripts, Dockerfiles, and CI.
5. **Regenerate the blueprint**:
   ```sh
   bunx bunderstack blueprint
   ```
6. **Verify build and tests**:
   ```sh
   bun run build
   bun test
   ```
