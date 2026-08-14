# Custom Hono Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `routes` config option that mounts a user-supplied Hono app inside bunderstack with a typed context, and clean up the config module's dead zod schema and duplicate env-injection option.

**Architecture:** A builder callback `routes: (ctx) => Hono` receives a context built once at construction, dodging the circular import that forces today's external-wrapper pattern. The returned app mounts at root _before_ the built-ins so custom routes take precedence, with a startup check over Hono's `app.routes` that rejects collisions with reserved prefixes or generated CRUD table routes. Mounting inside the app means the existing rate limiter covers custom routes automatically.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle ORM, Zod, `bun test`.

## Global Constraints

- Use Bun commands exclusively (`bun test`, `bun install`, `bunx`). Never npm/npx/jest/vitest.
- Spec: `docs/superpowers/specs/2026-08-07-custom-hono-routes-design.md`.
- Custom routes are **public by default** — bunderstack applies no implicit auth requirement.
- Session access is **lazy**: `getSession(request)` / `getUser(request)`, never an eagerly-resolved `user`.
- One Hono app, not keyed groups. Users compose internally with `.route()`.
- Bunderstack installs **no** error handler over custom routes; a throwing route gets Hono's default 500.
- No per-route rate-limit opt-out in this iteration.
- Reserved paths are exactly: `/health`, `/api/health`, `/api/realtime`, and prefixes `/api/auth/`, `/api/trpc/`, `/api/files/`, `/files/`, plus `/api/<tableName>` for each **access-enabled** table.
- A **disabled** table's name does not collide — no CRUD route exists for it.
- Tests live beside their source as `<name>.test.ts` and use `import { test, expect } from 'bun:test'`.
- Commit after every task using conventional-commit prefixes.

## Two things this plan covers

Tasks 1–2 are an agreed config cleanup with no separate spec, discussed and approved in conversation. Tasks 3–6 implement the routes spec. Cleanup comes first so the routes work lands on the tidied config type rather than churning it twice.

## Findings that shape Tasks 1–2 (verified in source, not assumed)

- `BunderstackConfig` is `Omit<z.input<typeof BunderstackOptionsSchema>, [12 keys]> & { … }`. The schema has 10 keys; the Omit list removes all but `rateLimit`, `idempotency`, `realtime` — **and those three are already hand-declared in the intersection at `config.ts:116-124`.** The `Omit<z.input<…>>` half therefore contributes nothing. Deleting it does not change the public type.
- The Omit list names five keys that are not in the schema at all (`authResolver`, `env`, `email`, `trpc`, `jobs`). `Omit` ignores unknown keys silently, which is why nobody noticed.
- `BunderstackOptionsSchema.parse(options)` produces `parsed`, which is read in exactly four places: `parsed.database?.url`, `parsed.database?.authToken`, `parsed.database?.migrations`, `parsed.realtime`. Every other consumer reads raw `options`. The schema performs no coercion — all four are optional passthroughs — so reading `options` directly is equivalent.
- The only behavior the parse provides is **throwing on malformed input from JavaScript callers**. That is worth keeping for the three union-shaped options, which is why Task 1 keeps a narrow `RuntimeOptionsSchema` rather than deleting validation outright.
- `envSource` is the third name for one idea: `validateEnv(config, { source })` and `resolveConfig(options, env, platformSource)` already both model "where env values come from," and both default to `process.env`.

## File Structure

| File                                                          | Responsibility                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/bunderstack/src/routes.ts` _(new)_                  | Route context type + factory, reserved-path table, collision validation                            |
| `packages/bunderstack/src/routes.test.ts` _(new)_             | Unit tests for collision validation                                                                |
| `packages/bunderstack/src/config.ts`                          | Hand-written `BunderstackConfig`; narrow `RuntimeOptionsSchema`; `processEnv` replaces `envSource` |
| `packages/bunderstack/src/handler.ts`                         | Mount the custom router first                                                                      |
| `packages/bunderstack/src/index.ts`                           | Build the context, invoke the callback, validate, pass to `buildHandler`; thread `processEnv`      |
| `packages/bunderstack/src/app-env.test.ts`                    | `envSource` → `processEnv`                                                                         |
| `packages/bunderstack/src/routes-integration.test.ts` _(new)_ | Precedence, rate limiting, raw body, no-routes-configured                                          |

---

### Task 1: Replace the dead options schema

**Files:**

- Modify: `packages/bunderstack/src/config.ts`
- Test: `packages/bunderstack/src/config.test.ts`

**Interfaces:**

- Consumes: nothing new
- Produces: `BunderstackOptionsSchema` no longer exported. New internal `RuntimeOptionsSchema` validating only `rateLimit`, `idempotency`, `realtime`. `BunderstackConfig<TSchema, TAccess, TStorage, TEnv>` keeps an identical public shape.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/config.test.ts`:

```ts
test('resolveConfig still reads database overrides from options', () => {
  const resolved = resolveConfig(
    {
      schema: {},
      database: {
        adapter: { dialect: 'sqlite' } as never,
        url: 'file:./explicit.db',
        authToken: 'tok',
        migrations: './custom-migrations',
      },
    } as never,
    { DATABASE_URL: 'file:./ignored.db' } as never,
    {},
  )
  expect(resolved.database.url).toBe('file:./explicit.db')
  expect(resolved.database.authToken).toBe('tok')
  expect(resolved.database.migrations).toBe('./custom-migrations')
})

test('resolveConfig still passes realtime through', () => {
  const resolved = resolveConfig(
    {
      schema: {},
      database: { adapter: { dialect: 'sqlite' } as never },
      realtime: { keepaliveMs: 5_000, redis: 'redis://localhost:6379' },
    } as never,
    { DATABASE_URL: 'file::memory:' } as never,
    {},
  )
  expect(resolved.realtime).toEqual({
    keepaliveMs: 5_000,
    redis: 'redis://localhost:6379',
  })
})

test('a malformed realtime option still throws', () => {
  expect(() =>
    resolveConfig(
      {
        schema: {},
        database: { adapter: { dialect: 'sqlite' } as never },
        realtime: { keepaliveMs: 'soon' },
      } as never,
      { DATABASE_URL: 'file::memory:' } as never,
      {},
    ),
  ).toThrow()
})

test('a malformed rateLimit option still throws', () => {
  expect(() =>
    resolveConfig(
      {
        schema: {},
        database: { adapter: { dialect: 'sqlite' } as never },
        rateLimit: { max: 'lots' },
      } as never,
      { DATABASE_URL: 'file::memory:' } as never,
      {},
    ),
  ).toThrow()
})

test('BunderstackOptionsSchema is no longer exported', async () => {
  const mod = await import('./config')
  expect('BunderstackOptionsSchema' in mod).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/config.test.ts`
Expected: only the last test fails — `BunderstackOptionsSchema` is still exported. The first four should already pass, which is the point: they pin current behavior before the refactor.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/config.ts`, replace `BunderstackOptionsSchema` with:

```ts
// Only the union-shaped options need runtime validation: they are the ones a
// JavaScript caller can plausibly get wrong in a way that fails confusingly
// downstream. Everything else is either typed-only or read raw from `options`.
const RuntimeOptionsSchema = z.object({
  rateLimit: z
    .union([
      z.boolean(),
      z.object({
        windowMs: z.number().optional(),
        max: z.number().optional(),
      }),
    ])
    .optional(),
  idempotency: z
    .union([z.boolean(), z.object({ ttlMs: z.number().optional() })])
    .optional(),
  realtime: z
    .union([
      z.boolean(),
      z.object({
        keepaliveMs: z.number().optional(),
        bufferSize: z.number().optional(),
        redis: z
          .union([
            z.string(),
            z.object({ url: z.string(), token: z.string().optional() }),
          ])
          .optional(),
      }),
    ])
    .optional(),
})
```

Replace the `BunderstackConfig` type header — delete the `Omit<z.input<…>, …> &` prefix entirely and keep only the object literal:

```ts
export type BunderstackConfig<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined =
    | Record<string, TableAccessInput>
    | undefined,
  TStorage extends StorageConfigInput | undefined =
    | StorageConfigInput
    | undefined,
  TEnv extends EnvConfigInput | undefined = EnvConfigInput | undefined,
> = {
  schema: TSchema
  access?: TAccess
  // … the existing body from `database:` through `realtime:` unchanged …
}
```

In `resolveConfig`, change the parse and the four `parsed.` reads:

```ts
const parsed = RuntimeOptionsSchema.parse(options)
```

then `parsed.database?.url` → `options.database?.url`, `parsed.database?.authToken` → `options.database?.authToken`, `parsed.database?.migrations` → `options.database?.migrations`. Leave `realtime: parsed.realtime` as-is — `realtime` is still on `RuntimeOptionsSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/config.test.ts && bun test packages/bunderstack`
Expected: PASS. The full package run matters here — this touches the type every other module consumes.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/config.test.ts
git commit -m "refactor(config): replace dead options schema with narrow runtime validation"
```

---

### Task 2: `processEnv` replaces `envSource`

**Files:**

- Modify: `packages/bunderstack/src/config.ts`, `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/app-env.test.ts`

**Interfaces:**

- Consumes: `BunderstackConfig` from Task 1
- Produces: `BunderstackConfig.processEnv?: Record<string, string | undefined>`, threaded to both `validateEnv({ source })` and `resolveConfig(_, _, platformSource)`. `envSource` removed.

- [ ] **Step 1: Update the failing tests**

In `packages/bunderstack/src/app-env.test.ts`, rename all three `envSource:` keys to `processEnv:`, then append:

```ts
test('processEnv feeds platform overrides as well as env vars', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    processEnv: {
      DATABASE_URL: 'file::memory:',
      BUNDERSTACK_DATABASE_URL: 'file::memory:',
      BUNDERSTACK_ROLE: 'web',
    },
  } as never)
  expect(app.env.BUNDERSTACK_ROLE).toBe('web')
  await app.close()
})

test('envSource is no longer accepted', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    envSource: { BUNDERSTACK_ROLE: 'worker' },
    processEnv: { DATABASE_URL: 'file::memory:' },
  } as never)
  // envSource is ignored entirely; the role falls back to its default.
  expect(app.env.BUNDERSTACK_ROLE).toBe('all')
  await app.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/app-env.test.ts`
Expected: FAIL — `processEnv` is not read, so the role tests fall back to `all`.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/config.ts`, delete `envSource?: Record<string, string | undefined>` from `BunderstackConfig` and add in its place:

```ts
  /**
   * Stand-in for `process.env`. Feeds both env validation and platform
   * overrides, so tests and embedders have one injection point instead of
   * three.
   */
  processEnv?: Record<string, string | undefined>
```

In `packages/bunderstack/src/index.ts`, change the `validateEnv` call at line ~336 from `source: options.envSource` to `source: options.processEnv`, and change `resolveConfig(options, env)` to:

```ts
const config = resolveConfig(options, env, options.processEnv)
```

`resolveConfig`'s third parameter already defaults to `process.env`, and a default parameter is used when the argument is `undefined` — so passing `options.processEnv` through preserves current behavior when it is unset.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/app-env.test.ts
git commit -m "refactor(config): replace envSource with a single processEnv injection point"
```

---

### Task 3: Reserved-path collision validation

**Files:**

- Create: `packages/bunderstack/src/routes.ts`
- Test: `packages/bunderstack/src/routes.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `type DeclaredRoute = { method: string; path: string }`; `validateCustomRoutes(routes: readonly DeclaredRoute[], tableNames: readonly string[]): void` — throws on collision, returns void otherwise

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/routes.test.ts`:

```ts
import { test, expect } from 'bun:test'

import { validateCustomRoutes } from './routes'

const ok = (path: string, tables: string[] = ['posts']) =>
  validateCustomRoutes([{ method: 'POST', path }], tables)

test('a non-colliding path is accepted', () => {
  expect(() => ok('/webhooks/telegram')).not.toThrow()
  expect(() => ok('/api/webhooks/stripe')).not.toThrow()
})

test('exact reserved paths are rejected', () => {
  expect(() => ok('/health')).toThrow(/health/)
  expect(() => ok('/api/health')).toThrow(/health/)
  expect(() => ok('/api/realtime')).toThrow(/realtime/)
})

test('reserved prefixes are rejected', () => {
  expect(() => ok('/api/auth/callback')).toThrow(/auth/)
  expect(() => ok('/api/trpc/anything')).toThrow(/trpc/)
  expect(() => ok('/api/files/x')).toThrow(/files/)
  expect(() => ok('/files/x')).toThrow(/files/)
})

test('an enabled table name is rejected', () => {
  expect(() => ok('/api/posts')).toThrow(/posts/)
  expect(() => ok('/api/posts/42')).toThrow(/posts/)
})

test('a table that is not enabled does not collide', () => {
  expect(() => ok('/api/drafts', ['posts'])).not.toThrow()
})

test('a param or wildcard first segment under /api is rejected', () => {
  expect(() => ok('/api/:anything')).toThrow(/shadow/)
  expect(() => ok('/api/:anything/x')).toThrow(/shadow/)
  expect(() => ok('/api/*')).toThrow(/shadow/)
})

test('params outside the first /api segment are fine', () => {
  expect(() => ok('/api/webhooks/:provider')).not.toThrow()
  expect(() => ok('/:anything')).not.toThrow()
})

test('the error names the offending path', () => {
  expect(() => ok('/api/posts')).toThrow(/POST \/api\/posts/)
})

test('every colliding route is reported, not just the first', () => {
  expect(() =>
    validateCustomRoutes(
      [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/api/posts' },
      ],
      ['posts'],
    ),
  ).toThrow(/health[\s\S]*posts/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/routes.test.ts`
Expected: FAIL — cannot resolve module `./routes`.

- [ ] **Step 3: Write the implementation**

Create `packages/bunderstack/src/routes.ts`:

```ts
// src/routes.ts — mounting user-supplied Hono routes inside the app.

/** A route as Hono reports it on `app.routes`. */
export type DeclaredRoute = { method: string; path: string }

const RESERVED_EXACT = ['/health', '/api/health', '/api/realtime'] as const

const RESERVED_PREFIXES = [
  '/api/auth/',
  '/api/trpc/',
  '/api/files/',
  '/files/',
] as const

/** The first path segment under `/api/`, or undefined when not under it. */
function apiSegment(path: string): string | undefined {
  if (!path.startsWith('/api/')) return undefined
  return path.slice('/api/'.length).split('/')[0]
}

function collisionFor(
  route: DeclaredRoute,
  tableNames: readonly string[],
): string | undefined {
  const { path } = route
  if (RESERVED_EXACT.includes(path as (typeof RESERVED_EXACT)[number])) {
    return `it is reserved by bunderstack`
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (path.startsWith(prefix)) {
      return `"${prefix}*" is reserved by bunderstack`
    }
  }
  const segment = apiSegment(path)
  if (segment === undefined) return undefined
  if (segment === '*' || segment.startsWith(':')) {
    return `a parameter or wildcard here would shadow every generated CRUD route`
  }
  if (tableNames.includes(segment)) {
    return `it collides with the generated CRUD route for table "${segment}"`
  }
  return undefined
}

/**
 * Throws when any declared route would collide with a bunderstack route.
 *
 * Custom routes are registered before the built-ins, so a collision silently
 * shadows core behaviour — including authentication. Failing at construction is
 * the cheapest place to find out.
 */
export function validateCustomRoutes(
  routes: readonly DeclaredRoute[],
  tableNames: readonly string[],
): void {
  const problems: string[] = []
  for (const route of routes) {
    const reason = collisionFor(route, tableNames)
    if (reason) {
      problems.push(`  ${route.method} ${route.path} — ${reason}`)
    }
  }
  if (problems.length === 0) return
  throw new Error(
    `[bunderstack] routes: ${problems.length} route(s) collide with bunderstack's own:\n${problems.join('\n')}\nChoose different paths.`,
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/routes.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/routes.ts packages/bunderstack/src/routes.test.ts
git commit -m "feat(routes): add reserved-path collision validation"
```

---

### Task 4: The route context

**Files:**

- Modify: `packages/bunderstack/src/routes.ts`
- Test: `packages/bunderstack/src/routes.test.ts`

**Interfaces:**

- Consumes: `resolveSession`, `resolveAccessUser` from `./access`; facade types from their modules
- Produces: `RouteContext<TSchema, TEnvResult>` and its alias `BunderstackRouteContext`; `createRouteContext(deps): RouteContext<…>`; `RoutesBuilder<TSchema, TEnvResult> = (ctx: RouteContext<TSchema, TEnvResult>) => Hono`

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/routes.test.ts`:

```ts
import { createRouteContext } from './routes'

test('createRouteContext exposes the framework facades', () => {
  const ctx = createRouteContext({
    db: 'DB' as never,
    env: { NODE_ENV: 'test' } as never,
    storage: 'STORAGE' as never,
    email: 'EMAIL' as never,
    jobs: 'JOBS' as never,
    realtime: 'REALTIME' as never,
    auth: 'AUTH' as never,
    authResolver: undefined,
  })
  expect(ctx.db).toBe('DB' as never)
  expect(ctx.storage).toBe('STORAGE' as never)
  expect(ctx.jobs).toBe('JOBS' as never)
  expect(typeof ctx.getSession).toBe('function')
  expect(typeof ctx.getUser).toBe('function')
})

test('getSession returns nulls when no auth resolver is configured', async () => {
  const ctx = createRouteContext({
    db: 'DB' as never,
    env: {} as never,
    storage: 'S' as never,
    email: 'E' as never,
    jobs: 'J' as never,
    realtime: 'R' as never,
    auth: 'A' as never,
    authResolver: undefined,
  })
  const session = await ctx.getSession(new Request('http://local/x'))
  expect(session).toEqual({ user: null, activeOrganizationId: null })
  expect(await ctx.getUser(new Request('http://local/x'))).toBeNull()
})

test('getSession is lazy — building the context resolves nothing', () => {
  let calls = 0
  const authResolver = {
    api: {
      getSession: async () => {
        calls++
        return null
      },
    },
  }
  createRouteContext({
    db: 'DB' as never,
    env: {} as never,
    storage: 'S' as never,
    email: 'E' as never,
    jobs: 'J' as never,
    realtime: 'R' as never,
    auth: 'A' as never,
    authResolver: authResolver as never,
  })
  expect(calls).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/routes.test.ts -t createRouteContext`
Expected: FAIL — `createRouteContext` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/bunderstack/src/routes.ts`:

```ts
import type { Hono } from 'hono'

import type { AccessUser, AuthSessionResolver } from './access'
import type { DbFor } from './db'
import type { EmailFacade } from './email'
import type { JobsRuntimeFacade } from './jobs/define'
import type { RealtimeFacade } from './realtime/facade'
import type { AuthInstance, StorageFacade } from './index'

import { resolveAccessUser, resolveSession } from './access'

export type RouteContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  /** Resolve the caller's session. Costs an auth round-trip; call only when needed. */
  getSession(
    request: Request,
  ): Promise<{ user: AccessUser | null; activeOrganizationId: string | null }>
  /** Convenience wrapper over getSession when the organization is irrelevant. */
  getUser(request: Request): Promise<AccessUser | null>
}

/** Alias mirroring the JobContext / BunderstackJobContext pair. */
export type BunderstackRouteContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = RouteContext<TSchema, TEnvResult>

export type RoutesBuilder<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = (ctx: RouteContext<TSchema, TEnvResult>) => Hono

export function createRouteContext<
  TSchema extends Record<string, unknown>,
  TEnvResult,
>(deps: {
  db: DbFor<TSchema>
  env: TEnvResult
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  authResolver: AuthSessionResolver | undefined
}): RouteContext<TSchema, TEnvResult> {
  return {
    db: deps.db,
    env: deps.env,
    storage: deps.storage,
    email: deps.email,
    jobs: deps.jobs,
    realtime: deps.realtime,
    auth: deps.auth,
    // Lazy on purpose: a webhook has no session, and resolving one eagerly
    // would spend an auth round-trip per request on a value nobody reads.
    getSession: (request) => resolveSession(deps.authResolver, request.headers),
    getUser: (request) => resolveAccessUser(deps.authResolver, request.headers),
  }
}
```

If importing `AuthInstance` / `StorageFacade` from `./index` creates a cycle the compiler rejects, move those two type declarations into their own modules and import from there — do not duplicate them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/routes.ts packages/bunderstack/src/routes.test.ts
git commit -m "feat(routes): add the typed route context"
```

---

### Task 5: Wire `routes` into the app

**Files:**

- Modify: `packages/bunderstack/src/config.ts`, `packages/bunderstack/src/handler.ts`, `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/routes-integration.test.ts` (create)

**Interfaces:**

- Consumes: `validateCustomRoutes`, `createRouteContext`, `RoutesBuilder` from `./routes`
- Produces: `BunderstackConfig.routes?: RoutesBuilder<TSchema, ValidatedEnv<TEnv>>`; `HandlerParts.customRouter?: Hono` mounted first

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/routes-integration.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { Hono } from 'hono'

import { createBunderstack } from './index'
import { libsql } from './database/libsql'

async function appWith(routes?: unknown) {
  return createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    processEnv: { DATABASE_URL: 'file::memory:', BUNDERSTACK_ROLE: 'web' },
    routes,
  } as never)
}

test('a custom route is served', async () => {
  const app = await appWith((ctx: { env: { BUNDERSTACK_ROLE: string } }) => {
    const r = new Hono()
    r.get('/webhooks/ping', (c) => c.json({ role: ctx.env.BUNDERSTACK_ROLE }))
    return r
  })
  const res = await app.handler(new Request('http://local/webhooks/ping'))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ role: 'web' })
  await app.close()
})

test('a custom route receives the exact raw body', async () => {
  const body = '{"update_id":1,"text":"hé\\u0000llo"}'
  let seen: string | undefined
  const app = await appWith(() => {
    const r = new Hono()
    r.post('/webhooks/raw', async (c) => {
      seen = await c.req.text()
      return c.json({ ok: true })
    })
    return r
  })
  await app.handler(
    new Request('http://local/webhooks/raw', { method: 'POST', body }),
  )
  expect(seen).toBe(body)
  await app.close()
})

test('an app with no routes configured still serves health', async () => {
  const app = await appWith(undefined)
  const res = await app.handler(new Request('http://local/health'))
  expect(res.status).toBe(200)
  await app.close()
})

test('a colliding custom route fails at construction', async () => {
  await expect(
    appWith(() => {
      const r = new Hono()
      r.get('/api/auth/steal', (c) => c.text('nope'))
      return r
    }),
  ).rejects.toThrow(/auth/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/routes-integration.test.ts`
Expected: FAIL — `routes` is ignored, so `/webhooks/ping` 404s.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/config.ts`, add to `BunderstackConfig` beside `rateLimit`:

```ts
  /**
   * Custom Hono routes, mounted at root ahead of bunderstack's own. Declared as
   * a callback because routes in a separate file cannot import the app that is
   * still being constructed — the same reason `trpc` takes a builder.
   */
  routes?: (ctx: never) => unknown
```

The precise generic form is declared on `createBunderstack`'s own overloads, matching how `trpc` and `jobs` are handled — see the comment at `config.ts:112-115`.

In `packages/bunderstack/src/handler.ts`, add `customRouter?: Hono` to `HandlerParts` and mount it **first**, immediately after `const app = new Hono()` and before the health routes:

```ts
// Registered ahead of everything so custom routes can sit in front of the
// core app. Collisions are rejected at construction, not silently shadowed.
if (parts.customRouter) app.route('/', parts.customRouter)
```

In `packages/bunderstack/src/index.ts`, before the `buildHandler` call:

```ts
const customRouter = options.routes
  ? (() => {
      const routeCtx = createRouteContext({
        db: userDb,
        env,
        storage,
        email,
        jobs,
        realtime,
        auth,
        authResolver,
      })
      const built = (options.routes as (ctx: unknown) => import('hono').Hono)(
        routeCtx,
      )
      const enabledTables = Object.values(options.schema)
        .filter((table) => isTable(table))
        .map((table) => getTableName(table))
        .filter((name) => tableEntryForName(access, name)?.enabled)
      validateCustomRoutes(built.routes, enabledTables)
      return built
    })()
  : undefined
```

and pass `customRouter` to `buildHandler`. Import `validateCustomRoutes` and `createRouteContext` from `./routes`, and re-export the public types from the package root:

```ts
export type {
  BunderstackRouteContext,
  RouteContext,
  RoutesBuilder,
} from './routes'
```

Use the same `isTable` / `getTableName` / `tableEntryForName` helpers the CRUD router already uses so the enabled-table list matches exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/routes-integration.test.ts && bun test packages/bunderstack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/handler.ts packages/bunderstack/src/index.ts packages/bunderstack/src/routes-integration.test.ts
git commit -m "feat(routes): mount custom Hono routes inside the app"
```

---

### Task 6: Rate limiting and precedence coverage

**Files:**

- Modify: `packages/bunderstack/src/routes-integration.test.ts`

**Interfaces:**

- Consumes: everything above
- Produces: no new API — closes the two behaviours the spec calls out as the point of mounting inside

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/routes-integration.test.ts`:

```ts
test('custom routes are rate limited', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    processEnv: { DATABASE_URL: 'file::memory:', BUNDERSTACK_ROLE: 'web' },
    rateLimit: { windowMs: 60_000, max: 2 },
    routes: () => {
      const r = new Hono()
      r.get('/webhooks/burst', (c) => c.text('ok'))
      return r
    },
  } as never)

  const hit = () =>
    app.handler(
      new Request('http://local/webhooks/burst', {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      }),
    )
  expect((await hit()).status).toBe(200)
  expect((await hit()).status).toBe(200)
  expect((await hit()).status).toBe(429)
  await app.close()
})

test('a custom route takes precedence over the built-in fallthrough', async () => {
  const app = await appWith(() => {
    const r = new Hono()
    r.get('/api/health', (c) => c.json({ mine: true }))
    return r
  })
  await app.close()
}, 1)
```

The second test is written to fail: `/api/health` is reserved, so construction throws before the assertion. Replace it with the passing form below once you confirm the throw — the point is to prove the reserved list is actually enforced end to end, not just in the unit test.

```ts
test('a custom route wins on a path bunderstack does not own', async () => {
  const app = await appWith(() => {
    const r = new Hono()
    r.get('/api/webhooks/status', (c) => c.json({ mine: true }))
    return r
  })
  const res = await app.handler(new Request('http://local/api/webhooks/status'))
  expect(await res.json()).toEqual({ mine: true })
  await app.close()
})
```

Keep only the passing form in the committed file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/routes-integration.test.ts -t "rate limited"`
Expected: FAIL if rate limiting does not reach custom routes. If it passes immediately, that is the correct outcome — mounting inside `router` is exactly what makes it work — so record that in the commit message rather than changing code.

- [ ] **Step 3: Confirm no implementation change is needed**

No code change should be required. If the rate-limit test fails, the custom router was mounted outside the rate-limited app; re-check Task 5's `handler.ts` change places `app.route('/', parts.customRouter)` on the same `app` instance that `checkRateLimit` wraps.

- [ ] **Step 4: Run the whole suite**

Run: `bun test packages/bunderstack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/routes-integration.test.ts
git commit -m "test(routes): cover rate limiting and precedence for custom routes"
```

---

## Self-Review

**Spec coverage**

| Spec requirement                                       | Task                         |
| ------------------------------------------------------ | ---------------------------- |
| `routes` builder callback returning a Hono app         | 5                            |
| Callback shape solves the circular import              | 5 (config comment)           |
| Context: db, env, storage, email, jobs, realtime, auth | 4                            |
| Lazy `getSession` / `getUser`                          | 4                            |
| Routes public by default, no implicit auth             | 4 (no auth applied anywhere) |
| `BunderstackRouteContext` exported alias               | 4, 5 (re-export)             |
| Mounted at root before built-ins                       | 5                            |
| `app.handler` remains the single entry point           | 5 (no new entry point added) |
| Reserved exact paths + prefixes                        | 3                            |
| Table-name collisions, enabled tables only             | 3, 5                         |
| Param/wildcard first segment under `/api/` rejected    | 3                            |
| Error names path and cause                             | 3                            |
| Rate limiting applies automatically                    | 6                            |
| Raw body intact                                        | 5                            |
| No error handler installed over user routes            | 5 (none added)               |
| One Hono app, no keyed groups                          | 5                            |
| No `routes` configured changes nothing                 | 5                            |
| **Config cleanup:** dead schema removed                | 1                            |
| **Config cleanup:** `envSource` → `processEnv`         | 2                            |

**Gap found and closed:** the spec's testing list includes "`getSession` returns the resolved user and active organization for an authenticated request." Task 4 covers only the no-resolver case, because constructing a real BetterAuth session in a unit test is disproportionate. The behaviour is delegated wholesale to `resolveSession`, which has its own coverage in `access.test.ts` — noted here rather than duplicated.

**Placeholder scan:** no TBD/TODO. Task 5's `routes?: (ctx: never) => unknown` in `BunderstackConfig` is deliberately loose and explained inline — it mirrors how `trpc` and `jobs` are already declared, with the inference-carrying form on `createBunderstack`'s overloads. Task 6 deliberately shows a failing test then its replacement; the instruction to commit only the passing form is explicit.

**Type consistency:** `DeclaredRoute` and `validateCustomRoutes` originate in Task 3 and are used in Task 5. `RouteContext` / `BunderstackRouteContext` / `RoutesBuilder` / `createRouteContext` originate in Task 4 and are used in Task 5. `processEnv` is introduced in Task 2 and used by every integration test in Tasks 5–6. `validateCustomRoutes(routes, tableNames)` takes `built.routes` directly, whose element shape (`{ method, path }`) matches `DeclaredRoute` — verified against Hono at runtime: `app.routes` returns `[{ method, path, handler }]` and `.route(prefix, sub)` flattens sub-app paths with the prefix applied.
