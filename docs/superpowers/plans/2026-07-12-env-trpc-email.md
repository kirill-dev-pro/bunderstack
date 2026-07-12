# Env Validation, tRPC Endpoints, and Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated env (built-in base schema + user extension), a tRPC endpoint layer defined from the bunderstack config, and email sending with better-auth auto-wiring — per `docs/superpowers/specs/2026-07-12-env-endpoints-email-design.md`.

**Architecture:** Three new modules in `packages/bunderstack/src` (`env.ts`, `email.ts`, `trpc.ts`) wired into `createBunderstack()` boot order: validate env → resolve config from env → create email facade → create auth with email defaults → build tRPC router from a builder callback and mount its fetch adapter at `/api/trpc/*`. `bunderstack-query` gains a `trpc` namespace on `createClient` backed by `@trpc/tanstack-react-query`.

**Tech Stack:** Bun, zod v4, tRPC v11 (`@trpc/server`, `@trpc/client`, `@trpc/tanstack-react-query`), superjson, better-auth, Hono, drizzle.

## Global Constraints

- Runtime/tooling is **Bun**: `bun test`, `bun install`, `bun add` (never npm/jest/vitest). Run tests with `bun test --cwd packages/<pkg> <file>`.
- Tests are co-located with source in `src/` and use `bun:test` (`import { test, expect } from 'bun:test'`).
- **Pre-existing failure baseline:** some existing tests import the deleted `examples/standalone/` and fail on main (3 bunderstack tests). Compare against that baseline, never against zero. Do NOT fix or touch them.
- **Define test schemas inline** with `sqliteTable` from `drizzle-orm/sqlite-core` — do not import from `examples/`.
- zod is `^4.4.3` (v4 API). tRPC packages at `^11`. superjson at `^2`.
- Dependency placement per spec: `@trpc/server` + `superjson` in `bunderstack`; `@trpc/client` + `@trpc/tanstack-react-query` + `superjson` in `bunderstack-query`; `nodemailer` optional peer of `bunderstack` (never installed).
- Client env prefix is exactly `PUBLIC_`.
- tRPC mounts at `/api/trpc/*`; superjson is the transformer on both sides.
- Commit style: conventional (`feat:`, `test:`, `docs:`), workspace root is the git root.
- Lint/format before finishing a task if files look off: `bun run fix` at repo root.

---

### Task 1: Env core — `validateEnv` with base schema, user extension, aggregated errors

**Files:**
- Create: `packages/bunderstack/src/env.ts`
- Create: `packages/bunderstack/src/env.test.ts`

**Interfaces:**
- Produces: `validateEnv<TEnv>(envConfig: TEnv, options?: ValidateEnvOptions): ValidatedEnv<TEnv>`, `BunderstackEnvError` (with `issues: string[]`), types `EnvConfigInput`, `BaseEnv`, `ValidatedEnv<TEnv>`, constant `CLIENT_PREFIX = 'PUBLIC_'`. `ValidateEnvOptions = { emailProvider?: string; source?: Record<string, string | undefined> }` (`source` defaults to `process.env` — tests always pass an explicit `source`).

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/env.test.ts`:

```ts
// src/env.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'

import { validateEnv, BunderstackEnvError } from './env'

test('base schema applies dev defaults with empty source', () => {
  const env = validateEnv(undefined, { source: {} })
  expect(env.DATABASE_URL).toBe('file:./data.db')
  expect(env.AUTH_SECRET).toBe('dev-secret-change-in-prod')
  expect(env.REDIS_URL).toBeUndefined()
})

test('base schema reads values from source', () => {
  const env = validateEnv(undefined, {
    source: {
      DATABASE_URL: 'libsql://x.turso.io',
      DATABASE_AUTH_TOKEN: 'tok',
      AUTH_SECRET: 's3cret',
      REDIS_URL: 'redis://localhost',
    },
  })
  expect(env.DATABASE_URL).toBe('libsql://x.turso.io')
  expect(env.DATABASE_AUTH_TOKEN).toBe('tok')
  expect(env.AUTH_SECRET).toBe('s3cret')
  expect(env.REDIS_URL).toBe('redis://localhost')
})

test('AUTH_SECRET is required in production', () => {
  expect(() =>
    validateEnv(undefined, { source: { NODE_ENV: 'production' } }),
  ).toThrow(BunderstackEnvError)
  try {
    validateEnv(undefined, { source: { NODE_ENV: 'production' } })
  } catch (e) {
    expect((e as BunderstackEnvError).issues.join(' ')).toContain('AUTH_SECRET')
  }
})

test('RESEND_API_KEY required only when email provider is resend', () => {
  // not required without provider
  expect(() => validateEnv(undefined, { source: {} })).not.toThrow()
  // required with provider
  expect(() =>
    validateEnv(undefined, { source: {}, emailProvider: 'resend' }),
  ).toThrow(/RESEND_API_KEY/)
  // satisfied
  const env = validateEnv(undefined, {
    source: { RESEND_API_KEY: 're_123' },
    emailProvider: 'resend',
  })
  expect(env.RESEND_API_KEY).toBe('re_123')
})

test('SMTP_URL required only when email provider is smtp', () => {
  expect(() =>
    validateEnv(undefined, { source: {}, emailProvider: 'smtp' }),
  ).toThrow(/SMTP_URL/)
})

test('user server extension is validated and typed', () => {
  const env = validateEnv(
    { server: { OPENAI_API_KEY: z.string() } },
    { source: { OPENAI_API_KEY: 'sk-1' } },
  )
  const key: string = env.OPENAI_API_KEY
  expect(key).toBe('sk-1')
})

test('user client extension is validated and typed', () => {
  const env = validateEnv(
    { client: { PUBLIC_APP_URL: z.string().url() } },
    { source: { PUBLIC_APP_URL: 'https://app.example.com' } },
  )
  expect(env.PUBLIC_APP_URL).toBe('https://app.example.com')
})

test('all failures are aggregated into one error', () => {
  try {
    validateEnv(
      {
        server: { OPENAI_API_KEY: z.string() },
        client: { PUBLIC_APP_URL: z.string().url() },
      },
      { source: { PUBLIC_APP_URL: 'not-a-url' } },
    )
    expect.unreachable()
  } catch (e) {
    const err = e as BunderstackEnvError
    expect(err.issues).toHaveLength(2)
    expect(err.message).toContain('OPENAI_API_KEY')
    expect(err.message).toContain('PUBLIC_APP_URL')
  }
})

test('server keys must not start with PUBLIC_', () => {
  expect(() =>
    validateEnv(
      { server: { PUBLIC_LEAK: z.string() } },
      { source: { PUBLIC_LEAK: 'x' } },
    ),
  ).toThrow(/PUBLIC_/)
})

test('client keys must start with PUBLIC_', () => {
  expect(() =>
    validateEnv(
      { client: { APP_URL: z.string() } },
      { source: { APP_URL: 'x' } },
    ),
  ).toThrow(/PUBLIC_/)
})

test('optional user vars may be absent', () => {
  const env = validateEnv(
    { server: { FEATURE_FLAG: z.string().optional() } },
    { source: {} },
  )
  expect(env.FEATURE_FLAG).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/env.test.ts`
Expected: FAIL — module `./env` not found.

- [ ] **Step 3: Write the implementation**

Create `packages/bunderstack/src/env.ts`:

```ts
// src/env.ts — env validation. Browser-safe: imports zod only.
import { z, type ZodType } from 'zod'

export const CLIENT_PREFIX = 'PUBLIC_' as const

export type EnvConfigInput = {
  server?: Record<string, ZodType>
  client?: Record<string, ZodType>
  /** Explicit value source for client vars (e.g. Vite's import.meta.env). */
  runtimeEnv?: Record<string, unknown>
}

/** Vars bunderstack itself consumes, always validated. */
export type BaseEnv = {
  NODE_ENV?: string
  DATABASE_URL: string
  DATABASE_AUTH_TOKEN?: string
  AUTH_SECRET: string
  REDIS_URL?: string
  RESEND_API_KEY?: string
  SMTP_URL?: string
}

type InferVars<T> = T extends Record<string, ZodType>
  ? { [K in keyof T]: z.output<T[K]> }
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}

export type ValidatedEnv<TEnv extends EnvConfigInput | undefined> = BaseEnv &
  InferVars<NonNullable<TEnv>['server']> &
  InferVars<NonNullable<TEnv>['client']>

export class BunderstackEnvError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid environment:\n  - ${issues.join('\n  - ')}`)
    this.name = 'BunderstackEnvError'
    this.issues = issues
  }
}

export type ValidateEnvOptions = {
  /** String tag of the configured email provider ('resend' | 'smtp'), if any. */
  emailProvider?: string
  /** Value source; defaults to process.env. Tests pass this explicitly. */
  source?: Record<string, string | undefined>
}

const DEV_AUTH_SECRET = 'dev-secret-change-in-prod'

function validateSection(
  section: Record<string, ZodType> | undefined,
  kind: 'server' | 'client',
  source: Record<string, unknown>,
  issues: string[],
  out: Record<string, unknown>,
) {
  for (const [key, schema] of Object.entries(section ?? {})) {
    const isPublic = key.startsWith(CLIENT_PREFIX)
    if (kind === 'server' && isPublic) {
      issues.push(
        `${key}: server vars must not start with ${CLIENT_PREFIX} (move it to env.client)`,
      )
      continue
    }
    if (kind === 'client' && !isPublic) {
      issues.push(
        `${key}: client vars must start with ${CLIENT_PREFIX} (rename it or move it to env.server)`,
      )
      continue
    }
    const result = schema.safeParse(source[key])
    if (result.success) {
      out[key] = result.data
    } else {
      for (const issue of result.error.issues) {
        issues.push(`${key}: ${issue.message}`)
      }
    }
  }
}

export function validateEnv<TEnv extends EnvConfigInput | undefined>(
  envConfig: TEnv,
  options: ValidateEnvOptions = {},
): ValidatedEnv<TEnv> {
  const source = options.source ?? (process.env as Record<string, string | undefined>)
  const issues: string[] = []
  const isProduction = source.NODE_ENV === 'production'

  const base: BaseEnv = {
    NODE_ENV: source.NODE_ENV,
    DATABASE_URL: source.DATABASE_URL ?? 'file:./data.db',
    DATABASE_AUTH_TOKEN: source.DATABASE_AUTH_TOKEN,
    AUTH_SECRET: source.AUTH_SECRET ?? DEV_AUTH_SECRET,
    REDIS_URL: source.REDIS_URL,
    RESEND_API_KEY: source.RESEND_API_KEY,
    SMTP_URL: source.SMTP_URL,
  }
  if (isProduction && !source.AUTH_SECRET) {
    issues.push('AUTH_SECRET: required in production')
  }
  if (options.emailProvider === 'resend' && !source.RESEND_API_KEY) {
    issues.push("RESEND_API_KEY: required when email provider is 'resend'")
  }
  if (options.emailProvider === 'smtp' && !source.SMTP_URL) {
    issues.push("SMTP_URL: required when email provider is 'smtp'")
  }

  const userVars: Record<string, unknown> = {}
  validateSection(envConfig?.server, 'server', source, issues, userVars)
  validateSection(envConfig?.client, 'client', source, issues, userVars)

  if (issues.length > 0) throw new BunderstackEnvError(issues)
  return { ...base, ...userVars } as ValidatedEnv<TEnv>
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/env.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts
git commit -m "feat(bunderstack): env validation with built-in base schema and user extension"
```

---

### Task 2: `createClientEnv` + browser-safe `bunderstack/env` subpath

**Files:**
- Modify: `packages/bunderstack/src/env.ts` (append)
- Modify: `packages/bunderstack/src/env.test.ts` (append)
- Modify: `packages/bunderstack/package.json` (exports map)

**Interfaces:**
- Consumes: `EnvConfigInput`, `CLIENT_PREFIX`, `BunderstackEnvError` from Task 1.
- Produces: `createClientEnv<TEnv extends EnvConfigInput>(envConfig: TEnv): InferVars<TEnv['client']>` — validates client section only; accessing a key declared in `envConfig.server` throws `"<key> is server-only"`. Subpath export `bunderstack/env`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/env.test.ts`:

```ts
import { createClientEnv } from './env'

test('createClientEnv validates client vars from runtimeEnv', () => {
  const env = createClientEnv({
    server: { SECRET_KEY: z.string() },
    client: { PUBLIC_APP_URL: z.string().url() },
    runtimeEnv: { PUBLIC_APP_URL: 'https://app.example.com' },
  })
  expect(env.PUBLIC_APP_URL).toBe('https://app.example.com')
})

test('createClientEnv throws on server key access', () => {
  const env = createClientEnv({
    server: { SECRET_KEY: z.string() },
    client: { PUBLIC_APP_URL: z.string() },
    runtimeEnv: { PUBLIC_APP_URL: 'x' },
  })
  expect(() => (env as Record<string, unknown>).SECRET_KEY).toThrow(
    /SECRET_KEY is server-only/,
  )
})

test('createClientEnv aggregates client validation failures', () => {
  expect(() =>
    createClientEnv({
      client: { PUBLIC_APP_URL: z.string().url() },
      runtimeEnv: { PUBLIC_APP_URL: 'not-a-url' },
    }),
  ).toThrow(BunderstackEnvError)
})

test('createClientEnv falls back to process.env', () => {
  process.env.PUBLIC_FROM_PROCESS = 'yes'
  const env = createClientEnv({ client: { PUBLIC_FROM_PROCESS: z.string() } })
  expect(env.PUBLIC_FROM_PROCESS).toBe('yes')
  delete process.env.PUBLIC_FROM_PROCESS
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/env.test.ts`
Expected: FAIL — `createClientEnv` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/bunderstack/src/env.ts`:

```ts
/**
 * Browser-side companion (t3-env style): validates ONLY the client section.
 * Server keys exist on the returned object as traps that throw on access, so
 * a leaked import fails loudly instead of silently reading undefined.
 */
export function createClientEnv<TEnv extends EnvConfigInput>(
  envConfig: TEnv,
): InferVars<TEnv['client']> {
  const source =
    envConfig.runtimeEnv ??
    (typeof process !== 'undefined'
      ? (process.env as Record<string, unknown>)
      : {})
  const issues: string[] = []
  const values: Record<string, unknown> = {}
  validateSection(envConfig.client, 'client', source, issues, values)
  if (issues.length > 0) throw new BunderstackEnvError(issues)

  const serverKeys = new Set(Object.keys(envConfig.server ?? {}))
  return new Proxy(values, {
    get(target, prop) {
      if (typeof prop === 'string' && serverKeys.has(prop)) {
        throw new Error(
          `${prop} is server-only and not available in client env`,
        )
      }
      return Reflect.get(target, prop)
    },
  }) as InferVars<TEnv['client']>
}
```

Note: `InferVars` is used in a public return type now — remove any `eslint-disable` noise if the linter is fine with `{}` via `bun run lint`.

In `packages/bunderstack/package.json`, extend `exports`:

```json
"exports": {
  ".": "./src/index.ts",
  "./access": "./src/access.ts",
  "./schema": "./src/schema-export.ts",
  "./typeid": "./src/typeid.ts",
  "./env": "./src/env.ts"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/env.test.ts`
Expected: PASS (15 tests).

Also verify browser-safety by import graph: `grep -n "^import" packages/bunderstack/src/env.ts` must show only `zod`.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts packages/bunderstack/package.json
git commit -m "feat(bunderstack): createClientEnv + browser-safe bunderstack/env subpath"
```

---

### Task 3: Wire env into `resolveConfig` / `createBunderstack`, expose `app.env`

**Files:**
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/config.test.ts` (append new tests only — do NOT touch existing tests)

**Interfaces:**
- Consumes: `validateEnv`, `ValidatedEnv`, `EnvConfigInput`, `BaseEnv` from Task 1.
- Produces:
  - `BunderstackConfig` gains `env?: TEnv` (new generic `TEnv extends EnvConfigInput | undefined`).
  - `resolveConfig(options, env?: BaseEnv)` — when `env` omitted it self-validates (back-compat for existing tests that mutate `process.env`).
  - `BunderstackApp` gains generic `TEnv` (default `undefined`) and property `env: ValidatedEnv<TEnv>`.
  - `createBunderstack` validates env FIRST in boot order and passes the result into `resolveConfig`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/config.test.ts` (this file currently fails at import time because it imports the deleted `examples/standalone/schema` — replace that import with an inline schema **only if** the whole file already fails to load; otherwise append only):

```ts
import { z } from 'zod'
import { validateEnv } from './env'

test('resolveConfig consumes a validated env for database url', () => {
  const env = validateEnv(undefined, {
    source: { DATABASE_URL: 'libsql://from-env.turso.io' },
  })
  const cfg = resolveConfig({ schema: {} }, env)
  expect(cfg.database.url).toBe('libsql://from-env.turso.io')
})

test('explicit config wins over env', () => {
  const env = validateEnv(undefined, {
    source: { DATABASE_URL: 'libsql://from-env.turso.io' },
  })
  const cfg = resolveConfig(
    { schema: {}, database: { url: 'file:./explicit.db' } },
    env,
  )
  expect(cfg.database.url).toBe('file:./explicit.db')
})

test('resolveConfig auth secret comes from validated env', () => {
  const env = validateEnv(undefined, { source: { AUTH_SECRET: 'from-env' } })
  const cfg = resolveConfig({ schema: {} }, env)
  expect(cfg.auth.secret).toBe('from-env')
})
```

Add an app-level test in a new file `packages/bunderstack/src/app-env.test.ts`:

```ts
// src/app-env.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createBunderstack } from './index'
import { BunderstackEnvError } from './env'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('createBunderstack exposes typed app.env', () => {
  process.env.MY_API_KEY = 'k-1'
  const app = createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
    env: { server: { MY_API_KEY: z.string() } },
  })
  const key: string = app.env.MY_API_KEY
  expect(key).toBe('k-1')
  expect(app.env.DATABASE_URL).toBe('file:./data.db')
  delete process.env.MY_API_KEY
})

test('createBunderstack refuses to boot on invalid env', () => {
  expect(() =>
    createBunderstack({
      schema: { notes },
      database: { url: ':memory:' },
      env: { server: { MISSING_REQUIRED: z.string() } },
    }),
  ).toThrow(BunderstackEnvError)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/app-env.test.ts`
Expected: FAIL — `env` is not a known config key / `app.env` undefined.

- [ ] **Step 3: Implement**

In `packages/bunderstack/src/config.ts`:

1. Add to imports: `import { validateEnv, type BaseEnv, type EnvConfigInput } from './env'`.
2. Add `env: z.unknown().optional(),` to `BunderstackOptionsSchema` (holds zod schemas — loose, like `storage`).
3. Add the generic + field to `BunderstackConfig`:

```ts
export type BunderstackConfig<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = ...,  // unchanged
  TStorage extends StorageConfigInput | undefined = ...,               // unchanged
  TEnv extends EnvConfigInput | undefined = EnvConfigInput | undefined,
> = Omit<
  z.input<typeof BunderstackOptionsSchema>,
  'schema' | 'access' | 'auth' | 'storage' | 'env'
> & {
  schema: TSchema
  access?: TAccess
  auth?: BetterAuthConfig
  storage?: TStorage
  env?: TEnv
  // ...rateLimit / idempotency / realtime unchanged
}
```

4. Change `resolveConfig` to consume a validated env (self-validating when omitted so the existing tests that mutate `process.env` keep passing):

```ts
export function resolveConfig<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
  env?: BaseEnv,
): ResolvedConfig {
  const parsed = BunderstackOptionsSchema.parse(options)
  const resolvedEnv = env ?? validateEnv(options.env as EnvConfigInput | undefined)

  return {
    database: {
      url: parsed.database?.url ?? resolvedEnv.DATABASE_URL,
      authToken: parsed.database?.authToken ?? resolvedEnv.DATABASE_AUTH_TOKEN,
    },
    auth: (() => {
      const authInput = options.auth ?? {}
      return { ...authInput, secret: authInput.secret ?? resolvedEnv.AUTH_SECRET }
    })(),
    storage: resolveBuckets(options.storage),
    realtime: parsed.realtime,
  }
}
```

5. `resolveRealtimeRedisUrl` gains an env parameter replacing its `process.env.REDIS_URL` read:

```ts
export function resolveRealtimeRedisUrl(
  realtime: ResolvedConfig['realtime'],
  env?: BaseEnv,
): string | undefined {
  const fromConfig = /* unchanged */
  return fromConfig ?? env?.REDIS_URL ?? process.env.REDIS_URL ?? undefined
}
```

In `packages/bunderstack/src/index.ts`:

1. Imports: `import { validateEnv, type EnvConfigInput, type ValidatedEnv } from './env'`.
2. `BunderstackApp` gains `TEnv extends EnvConfigInput | undefined = undefined` (after `TBuckets`) and field `env: ValidatedEnv<TEnv>`.
3. `createBunderstack` gains `const TEnv extends EnvConfigInput | undefined = undefined` in its generics, takes `options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv>`, returns `BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv>`.
4. Boot order — first lines of the function body become:

```ts
const env = validateEnv(options.env)
const config = resolveConfig(options, env)
```

5. Pass env to redis resolution: `resolveRealtimeRedisUrl(config.realtime, env)`.
6. Add `env` to the returned `app` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/app-env.test.ts src/env.test.ts src/index.test.ts`
Expected: new tests PASS; `index.test.ts` unchanged vs baseline.
Then full suite: `bun test --cwd packages/bunderstack` — same failures as the pre-existing baseline only.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/config.test.ts packages/bunderstack/src/app-env.test.ts
git commit -m "feat(bunderstack): validate env at boot, expose typed app.env"
```

---

### Task 4: Email core — adapters and facade

**Files:**
- Create: `packages/bunderstack/src/email.ts`
- Create: `packages/bunderstack/src/email.test.ts`

**Interfaces:**
- Produces:
  - Types: `EmailMessage`, `SentEmail = { id?: string }`, `EmailAdapter = { send(msg: EmailMessage & { from: string }): Promise<SentEmail> }`, `EmailConfigInput = { from: string; provider?: 'resend' | 'smtp' | 'console' | EmailAdapter | EmailAdapter['send'] }`, `EmailFacade = { send(msg: EmailMessage): Promise<SentEmail> }`.
  - `createEmail(config: EmailConfigInput | undefined, opts: CreateEmailOptions): EmailFacade` where `CreateEmailOptions = { env: { RESEND_API_KEY?: string; SMTP_URL?: string; NODE_ENV?: string }; fetchFn?: typeof fetch; canResolveModule?: (specifier: string) => boolean }` (last two are test seams).
  - `emailProviderTag(config: EmailConfigInput | undefined): string | undefined` — returns the provider when it is a string (feeds `validateEnv`'s conditional requirements in Task 5).

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/email.test.ts`:

```ts
// src/email.test.ts
import { test, expect } from 'bun:test'

import { createEmail, emailProviderTag } from './email'

const devEnv = { NODE_ENV: 'test' }

test('unconfigured email throws a clear error on send', async () => {
  const email = createEmail(undefined, { env: devEnv })
  expect(email.send({ to: 'a@b.c', subject: 'hi', text: 'x' })).rejects.toThrow(
    /email is not configured/,
  )
})

test('console provider is the dev default and logs instead of sending', async () => {
  const email = createEmail({ from: 'app@example.com' }, { env: devEnv })
  const result = await email.send({ to: 'a@b.c', subject: 'hi', text: 'body' })
  expect(result).toEqual({})
})

test('unset provider in production is a boot error', () => {
  expect(() =>
    createEmail({ from: 'app@example.com' }, { env: { NODE_ENV: 'production' } }),
  ).toThrow(/provider/)
})

test('message must have html or text', async () => {
  const email = createEmail({ from: 'app@example.com' }, { env: devEnv })
  expect(email.send({ to: 'a@b.c', subject: 'hi' })).rejects.toThrow(
    /html or text/,
  )
})

test('resend provider posts to the resend API with from default', async () => {
  let captured: { url: string; init: RequestInit } | undefined
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    captured = { url: String(url), init: init! }
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
  }) as typeof fetch
  const email = createEmail(
    { from: 'app@example.com', provider: 'resend' },
    { env: { ...devEnv, RESEND_API_KEY: 're_test' }, fetchFn },
  )
  const result = await email.send({ to: 'a@b.c', subject: 'hi', html: '<b>x</b>' })
  expect(result.id).toBe('email_123')
  expect(captured!.url).toBe('https://api.resend.com/emails')
  expect(captured!.init.headers).toMatchObject({
    Authorization: 'Bearer re_test',
    'Content-Type': 'application/json',
  })
  const body = JSON.parse(String(captured!.init.body))
  expect(body.from).toBe('app@example.com')
  expect(body.to).toEqual(['a@b.c'])
})

test('resend provider surfaces API errors', async () => {
  const fetchFn = (async () =>
    new Response('{"message":"invalid"}', { status: 422 })) as typeof fetch
  const email = createEmail(
    { from: 'app@example.com', provider: 'resend' },
    { env: { ...devEnv, RESEND_API_KEY: 're_test' }, fetchFn },
  )
  expect(email.send({ to: 'a@b.c', subject: 'hi', text: 'x' })).rejects.toThrow(
    /resend/i,
  )
})

test('custom adapter object is used as-is', async () => {
  const sent: unknown[] = []
  const email = createEmail(
    {
      from: 'app@example.com',
      provider: {
        send: async (msg) => {
          sent.push(msg)
          return { id: 'custom-1' }
        },
      },
    },
    { env: devEnv },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  expect(result.id).toBe('custom-1')
  expect((sent[0] as { from: string }).from).toBe('app@example.com')
})

test('bare function provider works', async () => {
  const email = createEmail(
    { from: 'app@example.com', provider: async () => ({ id: 'fn-1' }) },
    { env: devEnv },
  )
  const result = await email.send({ to: 'a@b.c', subject: 's', text: 't' })
  expect(result.id).toBe('fn-1')
})

test('smtp provider without nodemailer installed is a boot error', () => {
  expect(() =>
    createEmail(
      { from: 'app@example.com', provider: 'smtp' },
      {
        env: { ...devEnv, SMTP_URL: 'smtp://localhost' },
        canResolveModule: () => false,
      },
    ),
  ).toThrow(/nodemailer/)
})

test('emailProviderTag extracts string providers only', () => {
  expect(emailProviderTag({ from: 'a@b.c', provider: 'resend' })).toBe('resend')
  expect(emailProviderTag({ from: 'a@b.c', provider: async () => ({}) })).toBeUndefined()
  expect(emailProviderTag(undefined)).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/email.test.ts`
Expected: FAIL — module `./email` not found.

- [ ] **Step 3: Implement**

Create `packages/bunderstack/src/email.ts`:

```ts
// src/email.ts — email sending: resend / smtp / console / custom adapter.

export type EmailMessage = {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
}

export type SentEmail = { id?: string }

/** Adapters receive the message with `from` already resolved. */
export type EmailAdapter = {
  send(msg: EmailMessage & { from: string }): Promise<SentEmail>
}

export type EmailConfigInput = {
  from: string
  provider?: 'resend' | 'smtp' | 'console' | EmailAdapter | EmailAdapter['send']
}

export type EmailFacade = {
  send(msg: EmailMessage): Promise<SentEmail>
}

export type CreateEmailOptions = {
  env: { RESEND_API_KEY?: string; SMTP_URL?: string; NODE_ENV?: string }
  /** Test seam for the resend adapter. */
  fetchFn?: typeof fetch
  /** Test seam for the nodemailer presence check. */
  canResolveModule?: (specifier: string) => boolean
}

/** String provider tag ('resend' | 'smtp' | 'console') or undefined. */
export function emailProviderTag(
  config: EmailConfigInput | undefined,
): string | undefined {
  return typeof config?.provider === 'string' ? config.provider : undefined
}

const toArray = (v: string | string[] | undefined) =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v]

function createConsoleAdapter(): EmailAdapter {
  return {
    async send(msg) {
      const line = '─'.repeat(60)
      console.log(
        [
          line,
          `📧 email (console provider — not sent)`,
          `from:    ${msg.from}`,
          `to:      ${toArray(msg.to)!.join(', ')}`,
          `subject: ${msg.subject}`,
          line,
          msg.text ?? msg.html ?? '',
          line,
        ].join('\n'),
      )
      return {}
    },
  }
}

function createResendAdapter(apiKey: string, fetchFn: typeof fetch): EmailAdapter {
  return {
    async send(msg) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: msg.from,
          to: toArray(msg.to),
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: msg.replyTo,
          cc: toArray(msg.cc),
          bcc: toArray(msg.bcc),
        }),
      })
      if (!res.ok) {
        throw new Error(`resend API error (${res.status}): ${await res.text()}`)
      }
      const data = (await res.json()) as { id?: string }
      return { id: data.id }
    },
  }
}

function createSmtpAdapter(
  smtpUrl: string,
  canResolve: (specifier: string) => boolean,
): EmailAdapter {
  if (!canResolve('nodemailer')) {
    throw new Error(
      "email provider 'smtp' requires nodemailer — install it with: bun add nodemailer",
    )
  }
  // Lazy import so boot stays sync; cached across sends.
  let transportPromise: Promise<{
    sendMail(opts: Record<string, unknown>): Promise<{ messageId?: string }>
  }> | null = null
  const getTransport = () => {
    transportPromise ??= import('nodemailer').then((mod) =>
      (mod.default ?? mod).createTransport(smtpUrl),
    )
    return transportPromise
  }
  return {
    async send(msg) {
      const transport = await getTransport()
      const info = await transport.sendMail({
        from: msg.from,
        to: toArray(msg.to)!.join(', '),
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
        cc: toArray(msg.cc)?.join(', '),
        bcc: toArray(msg.bcc)?.join(', '),
      })
      return { id: info.messageId }
    },
  }
}

function defaultCanResolve(specifier: string): boolean {
  try {
    Bun.resolveSync(specifier, import.meta.dir)
    return true
  } catch {
    return false
  }
}

function resolveAdapter(
  config: EmailConfigInput,
  opts: CreateEmailOptions,
): EmailAdapter {
  const provider = config.provider
  if (typeof provider === 'function') return { send: provider }
  if (typeof provider === 'object') return provider
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis)
  switch (provider) {
    case 'resend':
      return createResendAdapter(opts.env.RESEND_API_KEY ?? '', fetchFn)
    case 'smtp':
      return createSmtpAdapter(
        opts.env.SMTP_URL ?? '',
        opts.canResolveModule ?? defaultCanResolve,
      )
    case 'console':
      return createConsoleAdapter()
    case undefined:
      if (opts.env.NODE_ENV === 'production') {
        throw new Error(
          'email is configured without a provider — set email.provider ' +
            "('resend' | 'smtp' | a custom adapter) for production",
        )
      }
      return createConsoleAdapter()
  }
}

export function createEmail(
  config: EmailConfigInput | undefined,
  opts: CreateEmailOptions,
): EmailFacade {
  if (!config) {
    return {
      async send() {
        throw new Error(
          'email is not configured — add an email key to your bunderstack config',
        )
      },
    }
  }
  const adapter = resolveAdapter(config, opts)
  return {
    async send(msg) {
      if (!msg.html && !msg.text) {
        throw new Error('email message needs html or text content')
      }
      return adapter.send({ ...msg, from: msg.from ?? config.from })
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/email.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/email.ts packages/bunderstack/src/email.test.ts
git commit -m "feat(bunderstack): email facade with resend/smtp/console/custom adapters"
```

---

### Task 5: Email in config — `app.email`, env conditionals, better-auth auto-wiring

**Files:**
- Modify: `packages/bunderstack/src/config.ts` (add `email` key)
- Modify: `packages/bunderstack/src/index.ts` (create facade, expose, pass provider tag to validateEnv)
- Modify: `packages/bunderstack/src/auth.ts` (add `withEmailAuthDefaults`)
- Create: `packages/bunderstack/src/auth-email.test.ts`

**Interfaces:**
- Consumes: `createEmail`, `emailProviderTag`, `EmailConfigInput`, `EmailFacade` (Task 4); `validateEnv` options (Task 1).
- Produces:
  - `BunderstackConfig.email?: EmailConfigInput`.
  - `BunderstackApp.email: EmailFacade`.
  - `withEmailAuthDefaults(cfg: BetterAuthConfig, email: EmailFacade, emailConfigured: boolean): BetterAuthConfig` — exported from `./auth`.

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/auth-email.test.ts`:

```ts
// src/auth-email.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { EmailFacade } from './email'
import { withEmailAuthDefaults } from './auth'
import { createBunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

const fakeEmail: EmailFacade = { send: async () => ({}) }

test('injects sendResetPassword when emailAndPassword is enabled without one', () => {
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true } },
    fakeEmail,
    true,
  )
  expect(typeof cfg.emailAndPassword?.sendResetPassword).toBe('function')
})

test('never overrides a user-supplied sendResetPassword', () => {
  const mine = async () => {}
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true, sendResetPassword: mine } },
    fakeEmail,
    true,
  )
  expect(cfg.emailAndPassword?.sendResetPassword).toBe(mine)
})

test('injects emailVerification.sendVerificationEmail', () => {
  const cfg = withEmailAuthDefaults({}, fakeEmail, true)
  expect(typeof cfg.emailVerification?.sendVerificationEmail).toBe('function')
})

test('no injection when email is not configured', () => {
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true } },
    fakeEmail,
    false,
  )
  expect(cfg.emailAndPassword?.sendResetPassword).toBeUndefined()
  expect(cfg.emailVerification).toBeUndefined()
})

test('default reset template sends through the facade', async () => {
  const sent: unknown[] = []
  const email: EmailFacade = {
    send: async (msg) => {
      sent.push(msg)
      return {}
    },
  }
  const cfg = withEmailAuthDefaults(
    { emailAndPassword: { enabled: true } },
    email,
    true,
  )
  await cfg.emailAndPassword!.sendResetPassword!(
    {
      user: { email: 'u@example.com', id: '1', name: 'U' },
      url: 'https://app/reset?token=t',
      token: 't',
    } as never,
    undefined as never,
  )
  expect(sent).toHaveLength(1)
  const msg = sent[0] as { to: string; text: string }
  expect(msg.to).toBe('u@example.com')
  expect(msg.text).toContain('https://app/reset?token=t')
})

test('app.email is exposed and unconfigured send throws', () => {
  const app = createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
  })
  expect(app.email.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(
    /email is not configured/,
  )
})

test('email provider resend requires RESEND_API_KEY at boot', () => {
  const hadKey = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  expect(() =>
    createBunderstack({
      schema: { notes },
      database: { url: ':memory:' },
      email: { from: 'app@example.com', provider: 'resend' },
    }),
  ).toThrow(/RESEND_API_KEY/)
  if (hadKey) process.env.RESEND_API_KEY = hadKey
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/auth-email.test.ts`
Expected: FAIL — `withEmailAuthDefaults` not exported.

- [ ] **Step 3: Implement**

In `packages/bunderstack/src/auth.ts`, add:

```ts
import type { EmailFacade } from './email'

/**
 * Fill better-auth's email hooks from the bunderstack email facade. Only fills
 * gaps: user-supplied handlers always win, and nothing is injected when email
 * isn't configured. emailAndPassword is only touched when the user enabled it
 * (injecting it unasked would enable the feature).
 */
export function withEmailAuthDefaults(
  cfg: BetterAuthConfig,
  email: EmailFacade,
  emailConfigured: boolean,
): BetterAuthConfig {
  if (!emailConfigured) return cfg
  const out: BetterAuthConfig = { ...cfg }

  if (cfg.emailAndPassword?.enabled && !cfg.emailAndPassword.sendResetPassword) {
    out.emailAndPassword = {
      ...cfg.emailAndPassword,
      sendResetPassword: async ({ user, url }) => {
        await email.send({
          to: user.email,
          subject: 'Reset your password',
          text: `Click the link to reset your password:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        })
      },
    }
  }

  if (!cfg.emailVerification?.sendVerificationEmail) {
    out.emailVerification = {
      ...cfg.emailVerification,
      sendVerificationEmail: async ({ user, url }) => {
        await email.send({
          to: user.email,
          subject: 'Verify your email',
          text: `Click the link to verify your email address:\n\n${url}`,
        })
      },
    }
  }

  return out
}
```

(If better-auth's option types for these callbacks differ slightly — e.g. an
extra `request` parameter — match the library types; the callback bodies stay
the same.)

In `packages/bunderstack/src/config.ts`:
- Add `email: z.unknown().optional(),` to `BunderstackOptionsSchema` (may hold functions — loose like `storage`).
- Add `email?: EmailConfigInput` to `BunderstackConfig` (import the type from `./email`), and add `'email'` to the `Omit<...>` key list.

In `packages/bunderstack/src/index.ts`:

```ts
import { createEmail, emailProviderTag, type EmailFacade } from './email'
import { withEmailAuthDefaults } from './auth'

// boot order (replaces the two lines from Task 3):
const env = validateEnv(options.env, {
  emailProvider: emailProviderTag(options.email),
})
const config = resolveConfig(options, env)
// ... mergedSchema/db as before ...
const email = createEmail(options.email, { env })
const auth = createAuth(
  db,
  withEmailAuthDefaults(config.auth, email, Boolean(options.email)),
)
```

- `BunderstackApp` gains `email: EmailFacade`; add `email` to the returned app object.
- Export from `src/index.ts`: `export { createEmail } from './email'` and `export type { EmailMessage, EmailAdapter, EmailConfigInput, EmailFacade } from './email'`.

In `packages/bunderstack/package.json`, add optional peer:

```json
"peerDependencies": { "drizzle-kit": "^0.30.0", "typescript": "^5", "nodemailer": "^6" },
"peerDependenciesMeta": { "drizzle-kit": { "optional": true }, "nodemailer": { "optional": true } }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/auth-email.test.ts src/email.test.ts src/app-env.test.ts`
Expected: PASS.
Full suite: `bun test --cwd packages/bunderstack` — baseline failures only.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/auth.ts packages/bunderstack/src/config.ts packages/bunderstack/src/index.ts packages/bunderstack/src/auth-email.test.ts packages/bunderstack/package.json
git commit -m "feat(bunderstack): email config key, app.email, better-auth email auto-wiring"
```

---

### Task 6: tRPC instance — `createTRPC`, context, `protectedProcedure`, superjson

**Files:**
- Modify: `packages/bunderstack/package.json` (deps + `./trpc` subpath)
- Create: `packages/bunderstack/src/trpc.ts`
- Create: `packages/bunderstack/src/trpc.test.ts`

**Interfaces:**
- Consumes: `AccessUser` (`./access`), `EmailFacade` (`./email`).
- Produces (from `bunderstack/trpc` and re-exported by `src/index.ts` in Task 7):
  - `TRPCContext<TSchema, TEnvResult>` = `{ db: LibSQLDatabase<TSchema>; user: AccessUser | null; env: TEnvResult; email: EmailFacade; req: Request }`
  - `createTRPC<TSchema, TEnvResult>(): { router, middleware, mergeRouters, procedure, protectedProcedure }`
  - `type BunderstackTRPC<TSchema, TEnvResult> = ReturnType<typeof createTRPC<TSchema, TEnvResult>>`

- [ ] **Step 1: Add dependencies**

In `packages/bunderstack/package.json` dependencies add:

```json
"@trpc/server": "^11.0.0",
"superjson": "^2.2.0"
```

Add to exports map: `"./trpc": "./src/trpc.ts"`.
Run: `bun install` (repo root). Expected: installs cleanly.

- [ ] **Step 2: Write the failing tests**

Create `packages/bunderstack/src/trpc.test.ts`:

```ts
// src/trpc.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { TRPCContext } from './trpc'
import type { EmailFacade } from './email'
import { createTRPC } from './trpc'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})
type Schema = { notes: typeof notes }

const fakeEmail: EmailFacade = { send: async () => ({}) }

function makeCtx(user: TRPCContext<Schema>['user']): TRPCContext<Schema> {
  return {
    db: null as never,
    user,
    env: {},
    email: fakeEmail,
    req: new Request('http://test/'),
  }
}

function makeRouter() {
  const t = createTRPC<Schema>()
  return t.router({
    echo: t.procedure
      .input(z.object({ msg: z.string(), at: z.date() }))
      .query(({ input }) => ({ echoed: input.msg, at: input.at })),
    whoami: t.protectedProcedure.query(({ ctx }) => ({ id: ctx.user.id })),
    bump: t.procedure
      .input(z.object({ n: z.number() }))
      .mutation(({ input }) => ({ n: input.n + 1 })),
  })
}

async function call(user: TRPCContext<Schema>['user'], req: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: makeRouter(),
    createContext: () => makeCtx(user),
  })
}

test('query round-trips Dates through superjson', async () => {
  const caller = makeRouter().createCaller(makeCtx(null))
  const at = new Date('2026-01-01T00:00:00Z')
  const result = await caller.echo({ msg: 'hi', at })
  expect(result.echoed).toBe('hi')
  expect(result.at).toBeInstanceOf(Date)
  expect(result.at.getTime()).toBe(at.getTime())
})

test('protectedProcedure throws UNAUTHORIZED without a user', async () => {
  const caller = makeRouter().createCaller(makeCtx(null))
  expect(caller.whoami()).rejects.toThrow(/UNAUTHORIZED/)
})

test('protectedProcedure narrows ctx.user with a session', async () => {
  const caller = makeRouter().createCaller(
    makeCtx({ id: 'u1', email: 'u@x.y', name: 'U' }),
  )
  const result = await caller.whoami()
  expect(result.id).toBe('u1')
})

test('mutation works over the fetch adapter', async () => {
  const res = await call(
    null,
    new Request('http://test/api/trpc/bump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: { n: 1 } }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    result: { data: { json: { n: number } } }
  }
  expect(body.result.data.json.n).toBe(2)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/trpc.test.ts`
Expected: FAIL — module `./trpc` not found.

- [ ] **Step 4: Implement**

Create `packages/bunderstack/src/trpc.ts`:

```ts
// src/trpc.ts — pre-wired tRPC instance for bunderstack endpoints.
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'

import type { AccessUser } from './access'
import type { EmailFacade } from './email'

export type TRPCContext<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: LibSQLDatabase<TSchema>
  user: AccessUser | null
  env: TEnvResult
  email: EmailFacade
  req: Request
}

/**
 * Build the `t` instance bunderstack hands to the config's `trpc` builder
 * callback (and exports for multi-file router setups). superjson is the
 * transformer, so Dates/Maps/Sets/BigInt/undefined round-trip.
 */
export function createTRPC<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
>() {
  const t = initTRPC.context<TRPCContext<TSchema, TEnvResult>>().create({
    transformer: superjson,
  })

  const protectedProcedure = t.procedure.use(({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
    return next({ ctx: { ...ctx, user: ctx.user } })
  })

  return {
    router: t.router,
    middleware: t.middleware,
    mergeRouters: t.mergeRouters,
    procedure: t.procedure,
    protectedProcedure,
  }
}

/** Type of the `t` instance — for builder callbacks declared in separate files. */
export type BunderstackTRPC<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = ReturnType<typeof createTRPC<TSchema, TEnvResult>>
```

Note for the implementer: in the `whoami` test, `ctx.user.id` compiling without
optional chaining is the type-level assertion that `protectedProcedure`
narrowed `user` to non-null. If tRPC's `next({ ctx })` spread doesn't narrow,
use `next({ ctx: { user: ctx.user } })` (tRPC merges partial ctx overrides).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/trpc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/package.json packages/bunderstack/src/trpc.ts packages/bunderstack/src/trpc.test.ts bun.lock
git commit -m "feat(bunderstack): pre-wired tRPC instance with protectedProcedure and superjson"
```

---

### Task 7: Mount tRPC — config `trpc` key (callback + prebuilt), handler route, `$inferClient` carrier

**Files:**
- Modify: `packages/bunderstack/src/config.ts` (add `trpc` key to zod options schema + config type)
- Modify: `packages/bunderstack/src/handler.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Create: `packages/bunderstack/src/trpc-mount.test.ts`

**Interfaces:**
- Consumes: `createTRPC`, `BunderstackTRPC`, `TRPCContext` (Task 6); `resolveAccessUser(auth: AuthSessionResolver | undefined, headers: Headers)` from `./access` (already exists, line ~487); validated `env` + `email` facade (Tasks 3/5).
- Produces:
  - `BunderstackConfig.trpc?: TTrpc` with generic `TTrpc extends AnyRouter | ((t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => AnyRouter) | undefined = undefined`.
  - `type RouterOf<TTrpc> = TTrpc extends (t: never) => infer R ? R : TTrpc extends AnyRouter ? TTrpc : undefined` (in `src/index.ts`).
  - `$inferClient` gains `trpc: RouterOf<TTrpc>`; `BunderstackApp` gains generic `TRouter` and field `trpcRouter?: AnyRouter` (runtime escape hatch, the raw router).
  - `handler.ts`: `HandlerParts` gains `trpcHandler?: (req: Request) => Promise<Response>`, mounted with `app.all('/api/trpc/*', (c) => parts.trpcHandler!(c.req.raw))`.
  - `src/index.ts` re-exports: `export { createTRPC } from './trpc'`, `export type { BunderstackTRPC, TRPCContext } from './trpc'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/trpc-mount.test.ts`:

```ts
// src/trpc-mount.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { z } from 'zod'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

import { createBunderstack, type BunderstackApp } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }),
})

let app: ReturnType<typeof buildApp>

function buildApp() {
  return createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
    env: { server: { GREETING: z.string().optional() } },
    trpc: (t) =>
      t.router({
        hello: t.procedure
          .input(z.object({ name: z.string() }))
          .query(({ input, ctx }) => ({
            // ctx.db / ctx.env are typed from the sibling config keys
            greeting: `${ctx.env.GREETING ?? 'hi'} ${input.name}`,
            at: new Date('2026-01-02T03:04:05Z'),
          })),
        secret: t.protectedProcedure.query(({ ctx }) => ({ id: ctx.user.id })),
      }),
  })
}

beforeAll(() => {
  app = buildApp()
})

function trpcUrl(path: string, input?: unknown) {
  const q =
    input === undefined
      ? ''
      : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  return `http://test/api/trpc/${path}${q}`
}

test('query procedure is served under /api/trpc', async () => {
  const res = await app.handler(new Request(trpcUrl('hello', { name: 'bun' })))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    result: { data: { json: { greeting: string }; meta?: unknown } }
  }
  expect(body.result.data.json.greeting).toBe('hi bun')
  // superjson meta marks the Date field
  expect(JSON.stringify(body.result.data.meta ?? {})).toContain('Date')
})

test('invalid input returns tRPC BAD_REQUEST', async () => {
  const res = await app.handler(new Request(trpcUrl('hello', { name: 42 })))
  expect(res.status).toBe(400)
})

test('protected procedure returns 401 without a session', async () => {
  const res = await app.handler(new Request(trpcUrl('secret')))
  expect(res.status).toBe(401)
})

test('unknown procedure 404s', async () => {
  const res = await app.handler(new Request(trpcUrl('nope')))
  expect(res.status).toBe(404)
})

test('prebuilt router escape hatch works', async () => {
  const { createTRPC } = await import('./trpc')
  const t = createTRPC<{ notes: typeof notes }>()
  const router = t.router({ ping: t.procedure.query(() => 'pong') })
  const prebuilt = createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
    trpc: router,
  })
  const res = await prebuilt.handler(new Request(trpcUrl('ping')))
  expect(res.status).toBe(200)
})

test('$inferClient carries the router type', () => {
  // Type-level: the carrier's trpc field is the router, not undefined.
  type Carrier = NonNullable<(typeof app)['$inferClient']>
  type HasTrpc = Carrier extends { trpc: infer R }
    ? R extends undefined
      ? false
      : true
    : false
  const check: HasTrpc = true
  expect(check).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --cwd packages/bunderstack src/trpc-mount.test.ts`
Expected: FAIL — `trpc` is not a config key (zod strip or type error).

- [ ] **Step 3: Implement**

In `packages/bunderstack/src/config.ts`:
- Add `trpc: z.unknown().optional(),` to `BunderstackOptionsSchema`.
- Add generic + field to `BunderstackConfig` (import `type { AnyRouter } from '@trpc/server'` and `type { BunderstackTRPC } from './trpc'`, `type { ValidatedEnv } from './env'`):

```ts
export type BunderstackConfig<
  TSchema extends Record<string, unknown>,
  TAccess ... = ...,          // unchanged
  TStorage ... = ...,         // unchanged
  TEnv extends EnvConfigInput | undefined = EnvConfigInput | undefined,
  TTrpc extends
    | AnyRouter
    | ((t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => AnyRouter)
    | undefined = AnyRouter | ((t: never) => AnyRouter) | undefined,
> = Omit<..., '... ' | 'trpc'> & {
  // ...existing fields...
  trpc?: TTrpc
}
```

In `packages/bunderstack/src/handler.ts`:

```ts
interface HandlerParts {
  // ...existing...
  trpcHandler?: (req: Request) => Promise<Response>
}
// inside buildHandler, after the realtime mount:
if (parts.trpcHandler) {
  app.all('/api/trpc/*', (c) => parts.trpcHandler!(c.req.raw))
}
```

In `packages/bunderstack/src/index.ts`:

```ts
import type { AnyRouter } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { resolveAccessUser } from './access'
import { createTRPC, type BunderstackTRPC } from './trpc'

/** Router type carried to the client: callback return, prebuilt router, or undefined. */
export type RouterOf<TTrpc> = TTrpc extends (t: never) => infer R
  ? R
  : TTrpc extends AnyRouter
    ? TTrpc
    : undefined
```

- `BunderstackApp` gains `TRouter = undefined` generic; `$inferClient` carrier gains `trpc: TRouter`; app type gains `trpcRouter?: AnyRouter`.
- `createBunderstack` generics gain `TTrpc extends AnyRouter | ((t: never) => AnyRouter) | undefined = undefined`; options typed `BunderstackConfig<TSchema, TAccess, TStorage, TEnv, TTrpc>`; return type `BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, RouterOf<TTrpc>>`.
- In the body, after `email`/`authResolver` exist:

```ts
const trpcRouter: AnyRouter | undefined =
  typeof options.trpc === 'function'
    ? (options.trpc as (t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => AnyRouter)(
        createTRPC<TSchema, ValidatedEnv<TEnv>>(),
      )
    : options.trpc
const trpcHandler = trpcRouter
  ? (req: Request) =>
      fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: trpcRouter,
        createContext: async () => ({
          db: userDb,
          user: await resolveAccessUser(authResolver, req.headers),
          env,
          email,
          req,
        }),
      })
  : undefined
```

- Pass `trpcHandler` into `buildHandler({...})`; add `trpcRouter` to the app object.
- Re-export: `export { createTRPC } from './trpc'`, `export type { BunderstackTRPC, TRPCContext } from './trpc'`, and `export type { RouterOf }` stays in index.

If the generic-callback contextual typing fights back (`trpc` callback param
resolving to `never` in the config literal), the known-good fallback is
declaring the config parameter of `createBunderstack` with the callback form
spelled inline rather than via the `TTrpc` union:
`trpc?: TTrpc | ((t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => TRouterCb)`
with a separate `TRouterCb extends AnyRouter = never` generic and
`RouterOf` selecting whichever is not `never`/`undefined`. Verify with the
type-level test in Step 1 plus `bunx tsc --noEmit` (compare against the
pre-existing tsc error baseline).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack src/trpc-mount.test.ts src/trpc.test.ts`
Expected: PASS.
Full suite: `bun test --cwd packages/bunderstack` — baseline failures only.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/handler.ts packages/bunderstack/src/index.ts packages/bunderstack/src/trpc-mount.test.ts
git commit -m "feat(bunderstack): trpc config key with builder callback, mounted at /api/trpc"
```

---

### Task 8: `bunderstack-query` — `trpc` namespace on `createClient`

**Files:**
- Modify: `packages/bunderstack-query/package.json` (deps)
- Modify: `packages/bunderstack-query/src/infer.ts`
- Modify: `packages/bunderstack-query/src/lazy-client.ts`
- Create: `packages/bunderstack-query/src/trpc-client.test.ts`

**Interfaces:**
- Consumes: server app from Task 7 (`$inferClient.trpc` carries the router type); `createTRPCOptionsProxy` + `TRPCOptionsProxy` from `@trpc/tanstack-react-query`; `createTRPCClient`, `httpBatchLink` from `@trpc/client`.
- Produces:
  - `ClientCarrier` gains **optional** `trpc?: unknown` (optional so pre-existing apps still satisfy `AnyBunderstackApp`).
  - `InferTrpcRouter<TApp>` type in `infer.ts`.
  - `BunderstackClient<TApp>` gains `trpc: TRPCOptionsProxy<Router>` when the app has a router (absent otherwise).
  - `createClient` serves `api.trpc.*` lazily; tRPC client uses `httpBatchLink({ url: `${baseUrl}/trpc`, transformer: superjson, fetch: fetchFn })`.

- [ ] **Step 1: Add dependencies**

In `packages/bunderstack-query/package.json` dependencies add:

```json
"@trpc/client": "^11.0.0",
"@trpc/server": "^11.0.0",
"@trpc/tanstack-react-query": "^11.0.0",
"superjson": "^2.2.0"
```

(`@trpc/server` is needed for the `AnyRouter` type and is a peer of the other two.)
Run `bun install` at repo root.

- [ ] **Step 2: Write the failing test**

Create `packages/bunderstack-query/src/trpc-client.test.ts`:

```ts
// src/trpc-client.test.ts — full round trip against a real bunderstack app.
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { QueryClient } from '@tanstack/react-query'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createBunderstack } from 'bunderstack'

import { createClient } from './lazy-client'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

const app = createBunderstack({
  schema: { notes },
  database: { url: ':memory:' },
  trpc: (t) =>
    t.router({
      hello: t.procedure
        .input(z.object({ name: z.string() }))
        .query(({ input }) => ({
          greeting: `hi ${input.name}`,
          at: new Date('2026-01-02T03:04:05Z'),
        })),
      bump: t.procedure
        .input(z.object({ n: z.number() }))
        .mutation(({ input }) => ({ n: input.n + 1 })),
    }),
})

// Route the client's fetch straight into the server handler.
const fetchViaApp = (async (input: RequestInfo | URL, init?: RequestInit) =>
  app.handler(new Request(input instanceof Request ? input : String(input), init))) as typeof fetch

const api = createClient<typeof app>({
  baseUrl: 'http://test/api',
  fetch: fetchViaApp,
  queryClient: new QueryClient(),
})

test('trpc queryOptions has a stable key and working queryFn', async () => {
  const options = api.trpc.hello.queryOptions({ name: 'bun' })
  expect(JSON.stringify(options.queryKey)).toContain('hello')
  const result = await new QueryClient().fetchQuery(options)
  expect(result.greeting).toBe('hi bun')
  expect(result.at).toBeInstanceOf(Date) // superjson round trip
})

test('trpc mutationOptions executes the mutation', async () => {
  const options = api.trpc.bump.mutationOptions()
  const result = await options.mutationFn!({ n: 41 })
  expect(result.n).toBe(42)
})

test('tables namespace still works alongside trpc', () => {
  expect(typeof api.notes.list).toBe('function')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test --cwd packages/bunderstack-query src/trpc-client.test.ts`
Expected: FAIL — `api.trpc` is undefined / type error.

- [ ] **Step 4: Implement**

In `packages/bunderstack-query/src/infer.ts`:

```ts
import type { AnyRouter } from '@trpc/server'

export type ClientCarrier = {
  schema: Record<string, unknown>
  access: unknown
  buckets: string
  trpc?: unknown   // optional: apps built before the trpc feature still match
}

export type InferTrpcRouter<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['trpc'] extends infer R
    ? R extends AnyRouter
      ? R
      : never
    : never
```

In `packages/bunderstack-query/src/lazy-client.ts`:

```ts
import type { AnyRouter } from '@trpc/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { QueryClient } from '@tanstack/react-query'
import superjson from 'superjson'

import type { InferTrpcRouter } from './infer'

export type BunderstackClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableQueryOptionsForKey<InferSchema<TApp>, K>
} & FilesQueryClient<InferBuckets<TApp>> &
  ([InferTrpcRouter<TApp>] extends [never]
    ? unknown
    : { trpc: TRPCOptionsProxy<InferTrpcRouter<TApp>> })
```

Inside `createClient`, before the returned Proxy:

```ts
let trpcProxy: unknown
const getTrpc = () => {
  trpcProxy ??= createTRPCOptionsProxy({
    client: createTRPCClient<AnyRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc`,
          transformer: superjson,
          fetch: fetchFn,
        }),
      ],
    }),
    queryClient: options.queryClient ?? new QueryClient(),
  })
  return trpcProxy
}
```

And in the Proxy `get`: `if (prop === 'trpc') return getTrpc()` (next to the `files` branch).

Also re-export the inference type from `src/index.ts`:
`export type { InferTrpcRouter } from './infer'`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test --cwd packages/bunderstack-query`
Expected: new tests PASS; rest of the package matches baseline.
Also run `bun test --cwd packages/bunderstack` to confirm no server regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack-query/package.json packages/bunderstack-query/src/infer.ts packages/bunderstack-query/src/lazy-client.ts packages/bunderstack-query/src/index.ts packages/bunderstack-query/src/trpc-client.test.ts bun.lock
git commit -m "feat(bunderstack-query): typed api.trpc namespace via @trpc/tanstack-react-query"
```

---

### Task 9: Showcase — feed procedure in the twitter example + docs

**Files:**
- Modify: `examples/twitter-tanstack/src/bunderstack.ts`
- Create: `examples/twitter-tanstack/src/hooks/use-feed.ts`
- Modify: `examples/README.md` (short mention)

**Interfaces:**
- Consumes: everything from Tasks 1–8. The example's schema (`examples/twitter-tanstack/src/schema.ts`) has `posts` (id, title, body, imageUrl, userId, replyToId, createdAt), `likes` (id, userId, postId, createdAt), `user`.
- Produces: a `feed` query procedure returning posts joined with author + like counts in one call, plus a client hook using it.

- [ ] **Step 1: Add the trpc callback to the example config**

In `examples/twitter-tanstack/src/bunderstack.ts`, add to the `createBunderstack({...})` object (after `storage`):

```ts
import { z } from 'zod'
import { desc, eq, sql } from 'bunderstack'

// inside createBunderstack({ ... }):
trpc: (t) =>
  t.router({
    feed: t.procedure
      .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }))
      .query(async ({ ctx, input }) => {
        // posts + author + like count in ONE round trip — the reason this
        // endpoint exists instead of three CRUD calls.
        const rows = await ctx.db
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
          .limit(input.limit)
        return rows // createdAt stays a Date thanks to superjson
      }),
  }),
```

(Adjust `schema.user.image` to the actual column if it differs — check
`examples/twitter-tanstack/src/schema.ts` lines 13–27.)

- [ ] **Step 2: Add the client hook**

Create `examples/twitter-tanstack/src/hooks/use-feed.ts` (match the import
style of the existing api client in `examples/twitter-tanstack/src/api-client.ts` —
it creates the typed client from `typeof app`):

```ts
import { useQuery } from '@tanstack/react-query'

import { api } from '../api-client'

export function useFeed(limit = 20) {
  return useQuery(api.trpc.feed.queryOptions({ limit }))
}
```

- [ ] **Step 3: Verify types and boot**

Run: `bunx tsc --noEmit` in `examples/twitter-tanstack` — errors must not
exceed the example's pre-existing baseline (check `git stash` / clean-tree
run first if unsure).
Run: `bun run --cwd examples/twitter-tanstack dev` briefly and
`curl 'http://localhost:3000/api/trpc/feed?input=%7B%22json%22%3A%7B%22limit%22%3A5%7D%7D'`
Expected: 200 with a superjson-enveloped result (empty array on a fresh db is fine). Stop the dev server after.

- [ ] **Step 4: Mention in examples README**

In `examples/README.md`, add one line to the twitter-tanstack description:
"Includes a tRPC `feed` procedure — posts, authors, and like counts in one call (`api.trpc.feed.queryOptions()`)."

- [ ] **Step 5: Commit**

```bash
git add examples/twitter-tanstack/src/bunderstack.ts examples/twitter-tanstack/src/hooks/use-feed.ts examples/README.md
git commit -m "docs(examples): tRPC feed procedure showcase in twitter-tanstack"
```

---

## Final verification (after all tasks)

- [ ] `bun test --cwd packages/bunderstack` — only the pre-existing baseline failures (tests importing deleted `examples/standalone`).
- [ ] `bun test --cwd packages/bunderstack-query` — green vs baseline.
- [ ] `bunx tsc --noEmit` in both packages — compare to the pre-existing tsc baseline, no new errors.
- [ ] `bun run fix` at repo root; commit any formatting deltas.
