# Storage Finish — Restructure + TypeScript Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the multi-bucket storage branch by eliminating the 5 remaining TypeScript errors and unifying the `src/` layout (one rule: multi-file domains are folders; tests co-locate under `src/`).

**Architecture:** Two self-contained type fixes first (a local drizzle test fixture; a better-auth → `AuthSessionResolver` boundary adapter), then a purely mechanical file move (`realtime/` folder + all tests pulled into `src/`). No runtime behavior changes.

**Tech Stack:** Bun, TypeScript 7.0.1-rc, drizzle-orm 0.45.2, better-auth 1.6.20, Hono.

## Global Constraints

- All commands run from `packages/bunderstack/` unless stated otherwise.
- `bunx tsc --noEmit` must end at **0 errors** by the end of the plan.
- `bun test` must stay green (currently 116+ pass, 0 fail) after every task.
- `verbatimModuleSyntax` is on: type-only imports MUST use `import type`.
- `noUncheckedIndexedAccess` is on: array/index access yields `T | undefined`.
- Do not change `app.auth` — it must keep exposing the raw better-auth instance.
- Use `git mv` for relocations so history is preserved.

---

### Task 1: Fix `db.test.ts` drizzle dual-instance error (Spec Section 3)

The test imports `posts` from `examples/standalone/schema`, which is built with
the workspace-root copy of drizzle-orm, while `createDb` uses the package's own
copy. Drizzle brands its column/table types per module instance, so the two are
nominally incompatible (the 2 errors at `tests/db.test.ts:20,23`). Fix: define a
local `posts` fixture using the package's own drizzle-orm.

**Files:**

- Modify: `packages/bunderstack/tests/db.test.ts` (full rewrite)

**Interfaces:**

- Consumes: `createDb(schema, config)` from `../src/db` (existing).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace the file contents**

```ts
import { test, expect } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createDb } from '../src/db'

// Local fixture built with THIS package's drizzle-orm instance, so the table's
// branded types match the db client createDb produces. (Importing the table
// from examples/ pulls in a second drizzle-orm copy and breaks type identity.)
const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
})

test('createDb returns a working Drizzle instance against in-memory SQLite', async () => {
  const db = createDb({ posts }, { url: ':memory:' })

  // Create the table manually (no drizzle-kit needed for the test)
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT
    )`,
  )

  const inserted = await db.insert(posts).values({ title: 'Hello' }).returning()
  expect(inserted[0]?.title).toBe('Hello')

  const all = await db.select().from(posts)
  expect(all).toHaveLength(1)
})
```

- [ ] **Step 2: Verify the two type errors are gone**

Run: `bunx tsc --noEmit 2>&1 | grep "db.test.ts"`
Expected: no output (the `db.test.ts(20,..)` / `(23,..)` errors are gone).

- [ ] **Step 3: Run the test**

Run: `bun test tests/db.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add tests/db.test.ts
git commit -m "fix(test): local drizzle fixture for db.test, drop examples import"
```

---

### Task 2: Auth resolver boundary adapter (Spec Section 2)

better-auth 1.6.20 types `api.getSession` as a union return — one branch is the
bare `{ session, user }`, the other a `{ headers, response }` wrapper — so the
raw `auth` instance no longer structurally satisfies `AuthSessionResolver` (the 3
errors at `src/index.ts:116,124,135`). Fix: add `toAuthSessionResolver(auth)` in
`auth.ts` that calls `getSession`, narrows the union, and returns our shape; wire
it into the three routers in `index.ts`.

**Files:**

- Modify: `packages/bunderstack/src/auth.ts`
- Create: `packages/bunderstack/src/auth-resolver.test.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**

- Consumes: `AuthSessionResolver` (from `./access.ts`), `createAuth` return type.
- Produces: `toAuthSessionResolver(auth: ReturnType<typeof createAuth>): AuthSessionResolver`.

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack/src/auth-resolver.test.ts`:

```ts
import { test, expect } from 'bun:test'

import { toAuthSessionResolver } from './auth.ts'

// A fake shaped like a better-auth instance's getSession result. Cast because
// the real parameter type is the full Auth instance.
const fakeAuth = (session: unknown) =>
  ({ api: { getSession: async () => session } }) as unknown as Parameters<
    typeof toAuthSessionResolver
  >[0]

test('maps a bare better-auth session to the resolver shape', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: { id: 'u1', email: 'a@b.c', name: 'Ann' },
      session: { activeOrganizationId: 'org1' },
    }),
  )
  const r = await resolver.api.getSession({ headers: new Headers() })
  expect(r).toEqual({
    user: { id: 'u1', email: 'a@b.c', name: 'Ann' },
    session: { activeOrganizationId: 'org1' },
  })
})

test('returns null when there is no session', async () => {
  const resolver = toAuthSessionResolver(fakeAuth(null))
  expect(await resolver.api.getSession({ headers: new Headers() })).toBeNull()
})

test('defaults activeOrganizationId to null when the session lacks one', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({ user: { id: 'u1', email: 'a@b.c', name: 'Ann' }, session: {} }),
  )
  const r = await resolver.api.getSession({ headers: new Headers() })
  expect(r?.session).toEqual({ activeOrganizationId: null })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/auth-resolver.test.ts`
Expected: FAIL — `toAuthSessionResolver` is not exported from `./auth.ts`.

- [ ] **Step 3: Implement the adapter in `auth.ts`**

Add the type-only import and the function to `packages/bunderstack/src/auth.ts`
(keep the existing `createAuth` export unchanged):

```ts
import type { AuthSessionResolver } from './access.ts'

/**
 * Adapt the raw better-auth instance to our internal {@link AuthSessionResolver}
 * contract. better-auth's `getSession` has a union return (a bare session, or a
 * `{ headers, response }` wrapper when `returnHeaders` is set); we only ever
 * call the bare form, so we narrow on `'user' in result` and map to our shape.
 * Keeping this adapter here means internal modules never depend on better-auth's
 * evolving types.
 */
export function toAuthSessionResolver(
  auth: ReturnType<typeof createAuth>,
): AuthSessionResolver {
  return {
    api: {
      async getSession({ headers }) {
        const result = await auth.api.getSession({ headers })
        if (result && 'user' in result && result.user) {
          const session = 'session' in result ? result.session : null
          return {
            user: {
              id: result.user.id,
              email: result.user.email,
              name: result.user.name,
            },
            session: session
              ? {
                  activeOrganizationId:
                    (session as { activeOrganizationId?: string | null })
                      .activeOrganizationId ?? null,
                }
              : null,
          }
        }
        return null
      },
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/auth-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the adapter into `index.ts`**

In `packages/bunderstack/src/index.ts`, add the import alongside the existing
`createAuth` import:

```ts
import { createAuth, toAuthSessionResolver } from './auth.ts'
```

Immediately after the `const auth = createAuth(...)` block (currently ending near
line 72), add:

```ts
// Internal routers consume the narrow AuthSessionResolver contract, not the
// raw better-auth instance. app.auth still exposes `auth` unchanged.
const authResolver = toAuthSessionResolver(auth)
```

Then replace the three router `auth` arguments to use `authResolver`:

- In the `buildCrudRouter(..., { auth, access, idempotency, broker })` options
  object, change `auth,` to `auth: authResolver,`.
- In `buildRealtimeRouter(broker, { auth, keepaliveMs: ... })`, change `auth,` to
  `auth: authResolver,`.
- In `buildBucketStorageRouter({ registry, db: ..., auth })`, change `auth` to
  `auth: authResolver`.

Leave the `auth` field on the returned app object as the raw `auth` instance.

- [ ] **Step 6: Verify the three index.ts errors are gone**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `0`

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: all pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/auth.ts src/auth-resolver.test.ts src/index.ts
git commit -m "fix(auth): adapt better-auth instance to AuthSessionResolver"
```

---

### Task 3: Promote `realtime/` to a folder

Move the two realtime source files into a `realtime/` folder (`index.ts` +
`redis.ts`) and pull the three realtime tests in beside them. This is the only
source-structure change; `crud` stays a flat `crud.ts`.

**Files:**

- Move: `src/realtime.ts` → `src/realtime/index.ts`
- Move: `src/realtime-redis.ts` → `src/realtime/redis.ts`
- Move: `src/realtime.test.ts` → `src/realtime/index.test.ts`
- Move: `src/realtime-sse.test.ts` → `src/realtime/sse.test.ts`
- Move: `src/realtime-redis.test.ts` → `src/realtime/redis.test.ts`
- Modify imports: the five moved files + `src/index.ts`

**Interfaces:**

- Produces new paths: `./realtime/index.ts` (was `./realtime.ts`) exporting
  `createRealtimeBroker`, `buildRealtimeRouter`, `createMemoryRealtimeBroker`,
  and types `RealtimeAction`, `RealtimeBroker`; `./realtime/redis.ts` (was
  `./realtime-redis.ts`) exporting `createRedisRealtimeBroker`, `RedisLike`.

- [ ] **Step 1: Move the files with git**

```bash
mkdir -p src/realtime
git mv src/realtime.ts src/realtime/index.ts
git mv src/realtime-redis.ts src/realtime/redis.ts
git mv src/realtime.test.ts src/realtime/index.test.ts
git mv src/realtime-sse.test.ts src/realtime/sse.test.ts
git mv src/realtime-redis.test.ts src/realtime/redis.test.ts
```

- [ ] **Step 2: Fix imports inside the moved files**

Apply these exact path rewrites (each file gains one `..` level for siblings;
intra-folder references switch to the new filenames):

```bash
# index.ts: access moves up a level
sed -i '' "s#from './access.ts'#from '../access.ts'#g" src/realtime/index.ts

# redis.ts: access up a level; realtime -> ./index
sed -i '' "s#from './access.ts'#from '../access.ts'#g" src/realtime/redis.ts
sed -i '' "s#from './realtime.ts'#from './index.ts'#g" src/realtime/redis.ts

# index.test.ts: access up; realtime -> ./index
sed -i '' "s#from './access.ts'#from '../access.ts'#g" src/realtime/index.test.ts
sed -i '' "s#from './realtime.ts'#from './index.ts'#g" src/realtime/index.test.ts

# sse.test.ts: access up; realtime -> ./index
sed -i '' "s#from './access.ts'#from '../access.ts'#g" src/realtime/sse.test.ts
sed -i '' "s#from './realtime.ts'#from './index.ts'#g" src/realtime/sse.test.ts

# redis.test.ts: access up; realtime-redis -> ./redis
sed -i '' "s#from './access.ts'#from '../access.ts'#g" src/realtime/redis.test.ts
sed -i '' "s#from './realtime-redis.ts'#from './redis.ts'#g" src/realtime/redis.test.ts
```

- [ ] **Step 3: Fix imports in `src/index.ts`**

```bash
sed -i '' "s#from './realtime-redis.ts'#from './realtime/redis.ts'#g" src/index.ts
sed -i '' "s#from './realtime.ts'#from './realtime/index.ts'#g" src/index.ts
```

- [ ] **Step 4: Confirm no stale references remain**

Run: `grep -rn "realtime-redis\|'./realtime.ts'\|\"./realtime.ts\"" src/`
Expected: no output.

- [ ] **Step 5: Typecheck and test**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS" && bun test src/realtime`
Expected: `0` errors; all realtime tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A src/realtime src/index.ts
git commit -m "refactor(realtime): promote to a folder (index.ts + redis.ts)"
```

---

### Task 4: Co-locate storage tests under `src/storage/`

Move the 9 `tests/storage/*.test.ts` files into `src/storage/` and rewrite their
import paths.

**Files:**

- Move: all of `tests/storage/*.test.ts` → `src/storage/`
- Modify imports: the moved files

**Interfaces:**

- Consumes: existing `src/storage/*` modules and sibling `src/*` modules.

- [ ] **Step 1: Move the test files**

```bash
git mv tests/storage/buckets.test.ts src/storage/buckets.test.ts
git mv tests/storage/file-meta.test.ts src/storage/file-meta.test.ts
git mv tests/storage/lifecycle.test.ts src/storage/lifecycle.test.ts
git mv tests/storage/local.test.ts src/storage/local.test.ts
git mv tests/storage/multibucket.integration.test.ts src/storage/multibucket.integration.test.ts
git mv tests/storage/registry.test.ts src/storage/registry.test.ts
git mv tests/storage/router.test.ts src/storage/router.test.ts
git mv tests/storage/s3.test.ts src/storage/s3.test.ts
git mv tests/storage/thumbnails.test.ts src/storage/thumbnails.test.ts
```

- [ ] **Step 2: Rewrite import paths (storage-specific first, then the rest)**

Order matters: collapse `../../src/storage/` → `./` before the general
`../../src/` → `../`, otherwise the storage paths would be mangled.

```bash
for f in src/storage/*.test.ts; do
  sed -i '' "s#'\.\./\.\./src/storage/#'./#g" "$f"
  sed -i '' "s#'\.\./\.\./src/#'../#g" "$f"
done
```

- [ ] **Step 3: Confirm no stale `../../src` references remain**

Run: `grep -rn "\.\./\.\./src" src/storage/`
Expected: no output.

- [ ] **Step 4: Typecheck and run storage tests**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS" && bun test src/storage`
Expected: `0` errors; all storage tests pass (was 116 across the suite; storage subset green).

- [ ] **Step 5: Commit**

```bash
git add -A src/storage tests/storage
git commit -m "refactor(storage): co-locate tests under src/storage"
```

---

### Task 5: Co-locate remaining `tests/` files and remove the directory

Move the flat `tests/*.test.ts` files into `src/`, rewrite their imports, delete
the now-empty `tests/` directory, and trim the dead `tests/**` glob from
`tsconfig.json`.

**Files:**

- Move: `tests/access.test.ts`, `tests/access.integration.test.ts`,
  `tests/auth.test.ts`, `tests/config.test.ts`, `tests/db.test.ts`,
  `tests/internal-tables.test.ts`, `tests/provision.test.ts`,
  `tests/provision.integration.test.ts`, `tests/rate-limit.test.ts`,
  `tests/typeid.test.ts` → `src/`
- Modify imports: the moved files (`db.test.ts` also drops to `./db`)
- Modify: `packages/bunderstack/tsconfig.json`
- Delete: `packages/bunderstack/tests/` (directory)

**Interfaces:**

- Consumes: sibling `src/*` modules; `../../../examples/standalone/schema` for
  the tests that build a full app (depth is identical from `src/`, so those
  imports are unchanged).

- [ ] **Step 1: Move the files**

```bash
git mv tests/access.test.ts src/access.test.ts
git mv tests/access.integration.test.ts src/access.integration.test.ts
git mv tests/auth.test.ts src/auth.test.ts
git mv tests/config.test.ts src/config.test.ts
git mv tests/db.test.ts src/db.test.ts
git mv tests/internal-tables.test.ts src/internal-tables.test.ts
git mv tests/provision.test.ts src/provision.test.ts
git mv tests/provision.integration.test.ts src/provision.integration.test.ts
git mv tests/rate-limit.test.ts src/rate-limit.test.ts
git mv tests/typeid.test.ts src/typeid.test.ts
```

- [ ] **Step 2: Rewrite `../src/` imports to `./`**

The only sibling-import prefix in these files is `../src/`; the
`../../../examples/...` imports keep working (same depth from `src/`).

```bash
for f in src/access.test.ts src/access.integration.test.ts src/auth.test.ts \
         src/config.test.ts src/db.test.ts src/internal-tables.test.ts \
         src/provision.test.ts src/provision.integration.test.ts \
         src/rate-limit.test.ts src/typeid.test.ts; do
  sed -i '' "s#'\.\./src/#'./#g" "$f"
done
```

- [ ] **Step 3: Confirm no stale `../src` references remain**

Run: `grep -rn "'\.\./src/" src/`
Expected: no output.

- [ ] **Step 4: Remove the empty `tests/` directory**

```bash
rmdir tests/storage tests 2>/dev/null || true
ls tests 2>&1 || echo "tests/ removed"
```

Expected: `tests/ removed` (directory is gone; if `rmdir` reports non-empty,
investigate leftover files before proceeding).

- [ ] **Step 5: Trim the dead glob from `tsconfig.json`**

In `packages/bunderstack/tsconfig.json`, change the `include` line:

```json
  "include": ["src/**/*.ts"],
```

(removing the now-nonexistent `"tests/**/*.ts"` entry).

- [ ] **Step 6: Full typecheck and test**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `0`

Run: `bun test`
Expected: all pass, 0 fail (same count as before the restructure, plus the 3 new
auth-resolver tests).

- [ ] **Step 7: Confirm the final layout**

Run: `find src -maxdepth 2 -type d && echo "---" && ls tests 2>&1`
Expected: `src`, `src/realtime`, `src/storage` directories; `tests` no longer
exists.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(tests): co-locate all tests under src, drop tests/ dir"
```

---

## Self-Review

**Spec coverage:**

- Section 1 (restructure): Tasks 3 (realtime folder), 4 (storage tests), 5 (flat
  tests + `tests/` removal + tsconfig). `crud` stays flat — matches the revised
  spec; its tests are already in `src/` (`crud-broadcast`, `crud-scope`) or move
  in Task 5 (`crud.test.ts`). Covered.
- Section 2 (auth resolver): Task 2. Covered.
- Section 3 (db.test fixture): Task 1. Covered.
- Verification (`tsc` 0 errors, `bun test` green): asserted at the end of every
  task. Covered.

**Placeholder scan:** No TBD/TODO/"handle errors" placeholders; every code step
shows full content and every command states its expected output.

**Type consistency:** `toAuthSessionResolver` signature and return shape are
identical in the test (Task 2 Step 1), the implementation (Step 3), and the
call sites (Step 5). The `AuthSessionResolver` shape used matches its definition
in `src/access.ts` (`{ api: { getSession: ({ headers }) => Promise<{ user, session? } | null> } }`).

**Ordering note:** `crud.test.ts` moves in Task 5 Step 1/2; its only sibling
import prefix is `../src/`, handled by the same loop.
