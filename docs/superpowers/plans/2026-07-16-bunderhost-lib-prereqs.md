# Bunderhost Library Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `bunderstack` library the two capabilities the Bunderhost platform needs: platform env overrides that beat code-level config (`BUNDERSTACK_DATABASE_URL`, `BUNDERSTACK_S3_*`) and a deploy-time introspection surface (`app.manifest` + `BUNDERSTACK_INTROSPECT=1` safe-boot mode).

**Architecture:** Overrides live at the two existing config-resolution choke points (`resolveConfig` for the database, `resolveBuckets` for storage) and read from an injectable env source so tests never mutate `process.env` for the new paths. Introspection is a pure `buildManifest()` module wired into `createBunderstack`, plus a `BUNDERSTACK_INTROSPECT=1` flag that makes env validation lenient and forces the database in-memory so importing a user's `src/bunderstack.ts` never touches the outside world.

**Tech Stack:** Bun, TypeScript, zod, drizzle. Tests with `bun test`.

**Spec:** `docs/superpowers/specs/2026-07-16-bunderhost-design.md` (section «Интроспекция декларации»).

## Global Constraints

- Run tests with `bun test <file>` from `packages/bunderstack/` (per repo CLAUDE.md: always `bun`, never node/jest/vitest).
- Commit style: conventional commits scoped to the package, e.g. `feat(bunderstack): …` (see `git log`).
- Precedence contract (verbatim from spec): platform override → code-level config → plain env fallback. Plain `DATABASE_URL`/`S3_*` keep their current semantics.
- Object keys are already `"<bucketName>/<uuid>"`, so ONE physical S3 bucket per environment is enough — the override sets a single shared backend for all logical buckets.
- `:memory:` is a valid in-memory URL for BOTH dialects: libsql accepts `:memory:` directly; `createDb`'s PGlite branch maps `:memory:` → `memory://` (`src/db.ts:88`).
- No new dependencies.

---

### Task 1: Platform override for database config

**Files:**
- Modify: `packages/bunderstack/src/config.ts:118-133` (`resolveConfig`)
- Test: `packages/bunderstack/src/config.test.ts`

**Interfaces:**
- Consumes: existing `resolveConfig(options, env?)` and `BaseEnv`.
- Produces: `resolveConfig(options, env?, platformSource?)` where `platformSource: Record<string, string | undefined>` defaults to `process.env`. Keys read: `BUNDERSTACK_DATABASE_URL`, `BUNDERSTACK_DATABASE_AUTH_TOKEN`. Task 2 threads the same `platformSource` into `resolveBuckets`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/config.test.ts`:

```ts
test('BUNDERSTACK_DATABASE_URL overrides code-level database config', () => {
  const cfg = resolveConfig(
    { schema, database: { url: 'file:./hardcoded.db', authToken: 'code-token' } },
    undefined,
    {
      BUNDERSTACK_DATABASE_URL: 'libsql://prod-app.turso.io',
      BUNDERSTACK_DATABASE_AUTH_TOKEN: 'platform-token',
    },
  )
  expect(cfg.database.url).toBe('libsql://prod-app.turso.io')
  expect(cfg.database.authToken).toBe('platform-token')
})

test('without platform vars, code-level database config still wins over env', () => {
  const cfg = resolveConfig(
    { schema, database: { url: 'file:./hardcoded.db' } },
    undefined,
    {},
  )
  expect(cfg.database.url).toBe('file:./hardcoded.db')
})
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `cd packages/bunderstack && bun test src/config.test.ts`
Expected: FAIL — `resolveConfig` ignores the third argument (url stays `file:./hardcoded.db`), first new test red, second green.

- [ ] **Step 3: Implement the override**

In `packages/bunderstack/src/config.ts`, change `resolveConfig`:

```ts
export function resolveConfig<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
  env?: BaseEnv,
  // Platform-injected overrides (Bunderhost & co.) beat code-level config so
  // apps with hardcoded local urls deploy unchanged.
  platformSource: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): ResolvedConfig {
  const parsed = BunderstackOptionsSchema.parse(options)
  // Self-validate when the caller didn't pass a pre-validated env, so
  // resolveConfig stays usable standalone.
  const resolvedEnv =
    env ?? validateEnv(options.env as EnvConfigInput | undefined)

  return {
    database: {
      url:
        platformSource['BUNDERSTACK_DATABASE_URL'] ??
        parsed.database?.url ??
        resolvedEnv.DATABASE_URL,
      authToken:
        platformSource['BUNDERSTACK_DATABASE_AUTH_TOKEN'] ??
        parsed.database?.authToken ??
        resolvedEnv.DATABASE_AUTH_TOKEN,
      migrations: parsed.database?.migrations ?? './migrations',
    },
    // …auth/storage/realtime unchanged in this task…
  }
}
```

Only the two `url`/`authToken` lines and the signature change; everything else stays as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/bunderstack && bun test src/config.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/config.ts packages/bunderstack/src/config.test.ts
git commit -m "feat(bunderstack): BUNDERSTACK_DATABASE_URL platform override beats code config"
```

---

### Task 2: Platform override for the storage backend

**Files:**
- Modify: `packages/bunderstack/src/storage/buckets.ts:115-170` (shared/per-bucket backend resolution), `packages/bunderstack/src/config.ts:141` (thread `platformSource`)
- Test: `packages/bunderstack/src/storage/buckets.test.ts`

**Interfaces:**
- Consumes: `resolveBuckets(input, env = process.env)` (unchanged signature — the override reads the same `env` source), `ResolvedBackend` from `./storage/buckets`.
- Produces: when `env['BUNDERSTACK_S3_ENDPOINT']` is set, ALL buckets resolve onto one S3 backend built from `BUNDERSTACK_S3_ENDPOINT`, `BUNDERSTACK_S3_BUCKET`, `BUNDERSTACK_S3_REGION` (default `'auto'`), `BUNDERSTACK_S3_ACCESS_KEY_ID`, `BUNDERSTACK_S3_SECRET_ACCESS_KEY`, `BUNDERSTACK_S3_PUBLIC_URL` — ignoring code-level `local` and per-bucket `s3` blocks. Bucket `visibility`/`access`/`upload` settings still come from code.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/storage/buckets.test.ts` (match the file's existing import of `resolveBuckets`):

```ts
const PLATFORM_ENV = {
  BUNDERSTACK_S3_ENDPOINT: 'https://t3.storage.dev',
  BUNDERSTACK_S3_BUCKET: 'bunderhost-myproj-prod',
  BUNDERSTACK_S3_ACCESS_KEY_ID: 'tid_platform',
  BUNDERSTACK_S3_SECRET_ACCESS_KEY: 'tsec_platform',
  BUNDERSTACK_S3_PUBLIC_URL: 'https://bunderhost-myproj-prod.fly.storage.tigris.dev',
}

test('BUNDERSTACK_S3_ENDPOINT forces local storage onto the platform backend', () => {
  const resolved = resolveBuckets(
    { local: './uploads', buckets: { avatars: { visibility: 'public' } } },
    PLATFORM_ENV,
  )
  const backend = resolved.buckets.get('avatars')?.backend
  expect(backend?.type).toBe('s3')
  if (backend?.type === 's3') {
    expect(backend.bucket).toBe('bunderhost-myproj-prod')
    expect(backend.endpoint).toBe('https://t3.storage.dev')
    expect(backend.accessKeyId).toBe('tid_platform')
    expect(backend.publicUrl).toBe(
      'https://bunderhost-myproj-prod.fly.storage.tigris.dev',
    )
  }
  // Code-level bucket settings survive the backend override.
  expect(resolved.buckets.get('avatars')?.visibility).toBe('public')
})

test('platform override beats per-bucket s3 blocks', () => {
  const resolved = resolveBuckets(
    { s3: true, buckets: { docs: { s3: { bucket: 'my-own-bucket' } } } },
    PLATFORM_ENV,
  )
  const backend = resolved.buckets.get('docs')?.backend
  expect(backend?.type).toBe('s3')
  if (backend?.type === 's3') {
    expect(backend.bucket).toBe('bunderhost-myproj-prod')
  }
})

test('platform override applies to the synthesized default bucket', () => {
  const resolved = resolveBuckets(undefined, PLATFORM_ENV)
  const backend = resolved.buckets.get('default')?.backend
  expect(backend?.type).toBe('s3')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/bunderstack && bun test src/storage/buckets.test.ts`
Expected: FAIL — backends resolve to `local` (first/third test) and `my-own-bucket` (second test).

- [ ] **Step 3: Implement the override**

In `packages/bunderstack/src/storage/buckets.ts` add above `resolveSharedBackend`:

```ts
// ---------------------------------------------------------------------------
// Platform override (Bunderhost & co.)
// ---------------------------------------------------------------------------

/**
 * A deployment platform that injects BUNDERSTACK_S3_ENDPOINT forces every
 * bucket onto that backend — code-level `local`/per-bucket `s3` blocks are
 * ignored so apps deploy unchanged. Logical buckets already prefix object
 * keys ("<bucket>/<uuid>"), so one physical bucket per environment suffices.
 */
function platformS3Backend(
  env: Record<string, string | undefined>,
): ResolvedBackend | undefined {
  const endpoint = env['BUNDERSTACK_S3_ENDPOINT']
  if (!endpoint) return undefined
  return {
    type: 's3',
    bucket: env['BUNDERSTACK_S3_BUCKET'] ?? '',
    region: env['BUNDERSTACK_S3_REGION'] ?? 'auto',
    endpoint,
    accessKeyId: env['BUNDERSTACK_S3_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: env['BUNDERSTACK_S3_SECRET_ACCESS_KEY'] ?? '',
    publicUrl: env['BUNDERSTACK_S3_PUBLIC_URL'],
  }
}
```

In `resolveBucketBackend`, short-circuit first:

```ts
function resolveBucketBackend(
  bucketInput: BucketConfigInput,
  sharedBackend: ResolvedBackend,
  env: Record<string, string | undefined>,
): ResolvedBackend {
  // Platform override active → sharedBackend IS the platform backend and
  // code-level per-bucket backends are ignored.
  if (env['BUNDERSTACK_S3_ENDPOINT']) return sharedBackend
  // …existing body unchanged…
}
```

In `resolveBuckets`, replace the first line of the body:

```ts
const sharedBackend =
  platformS3Backend(env) ?? resolveSharedBackend(input, env)
```

In `packages/bunderstack/src/config.ts` (Task 1's `resolveConfig`), thread the source:

```ts
storage: resolveBuckets(
  options.storage as StorageConfigInput | undefined,
  platformSource,
),
```

(Keep the existing cast style if the current call site has none — check how `options.storage` is passed today at `config.ts:141` and preserve it, only adding the second argument.)

- [ ] **Step 4: Run storage + config tests**

Run: `cd packages/bunderstack && bun test src/storage/buckets.test.ts src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/storage/buckets.ts packages/bunderstack/src/config.ts packages/bunderstack/src/storage/buckets.test.ts
git commit -m "feat(bunderstack): BUNDERSTACK_S3_* platform override forces all buckets onto one backend"
```

---

### Task 3: Lenient env validation under BUNDERSTACK_INTROSPECT

**Files:**
- Modify: `packages/bunderstack/src/env.ts:90-125` (`validateEnv`)
- Test: `packages/bunderstack/src/env.test.ts`

**Interfaces:**
- Consumes: existing `validateEnv(envConfig, options)`.
- Produces: when the value source has `BUNDERSTACK_INTROSPECT === '1'`, `validateEnv` returns instead of throwing `BunderstackEnvError`; failed keys are simply absent from the result. No signature change.

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/env.test.ts` (the file already imports `validateEnv` and `z`):

```ts
test('BUNDERSTACK_INTROSPECT=1 returns instead of throwing on invalid env', () => {
  const env = validateEnv(
    { server: { STRIPE_KEY: z.string() } },
    { source: { BUNDERSTACK_INTROSPECT: '1', NODE_ENV: 'production' } },
  )
  // Missing STRIPE_KEY and missing production AUTH_SECRET are both tolerated.
  expect(env.DATABASE_URL).toBe('file:./data.db')
  expect((env as Record<string, unknown>).STRIPE_KEY).toBeUndefined()
})

test('without the introspect flag the same env still throws', () => {
  expect(() =>
    validateEnv(
      { server: { STRIPE_KEY: z.string() } },
      { source: { NODE_ENV: 'production' } },
    ),
  ).toThrow(BunderstackEnvError)
})
```

(If `BunderstackEnvError` isn't imported in the test file yet, add it to the existing import from `./env`.)

- [ ] **Step 2: Run tests to verify the first fails**

Run: `cd packages/bunderstack && bun test src/env.test.ts`
Expected: FAIL — first test throws `BunderstackEnvError`.

- [ ] **Step 3: Implement**

In `validateEnv` (`packages/bunderstack/src/env.ts`), replace the throw line:

```ts
  // Introspection (Bunderhost builder) imports the app declaration to read
  // its manifest; missing user env must not kill the boot there.
  const lenient = source.BUNDERSTACK_INTROSPECT === '1'
  if (issues.length > 0 && !lenient) throw new BunderstackEnvError(issues)
  return { ...base, ...userVars } as ValidatedEnv<TEnv>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/bunderstack && bun test src/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts
git commit -m "feat(bunderstack): BUNDERSTACK_INTROSPECT=1 makes env validation lenient"
```

---

### Task 4: Manifest module

**Files:**
- Create: `packages/bunderstack/src/manifest.ts`
- Test: `packages/bunderstack/src/manifest.test.ts`

**Interfaces:**
- Consumes: `Dialect` from `./dialect`, `EnvConfigInput` from `./env`, `ResolvedStorageBuckets`/`ResolvedBucket` and `resolveBuckets` from `./storage/buckets`.
- Produces (Task 5 relies on these exact names):

```ts
export type ManifestEnvVar = { key: string; required: boolean }
export type BunderstackManifest = {
  dialect: Dialect
  tables: string[]
  defaultBucket: string
  buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  realtime: boolean
  env: { server: ManifestEnvVar[]; client: ManifestEnvVar[] }
}
export function buildManifest(args: {
  schema: Record<string, unknown>
  dialect: Dialect
  storage: ResolvedStorageBuckets
  envConfig: EnvConfigInput | undefined
  realtime: boolean
}): BunderstackManifest
```

- [ ] **Step 1: Write the failing test**

Create `packages/bunderstack/src/manifest.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { buildManifest } from './manifest'
import { resolveBuckets } from './storage/buckets'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
})
const schema = { posts }

test('buildManifest describes tables, buckets, env requirements', () => {
  const storage = resolveBuckets(
    {
      local: './uploads',
      defaultBucket: 'attachments',
      buckets: {
        avatars: { visibility: 'public' },
        attachments: {},
      },
    },
    {},
  )
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage,
    envConfig: {
      server: { STRIPE_KEY: z.string(), LOG_LEVEL: z.string().optional() },
      client: { PUBLIC_APP_NAME: z.string() },
    },
    realtime: true,
  })

  expect(manifest.dialect).toBe('sqlite')
  expect(manifest.tables).toEqual(['posts'])
  expect(manifest.defaultBucket).toBe('attachments')
  expect(manifest.buckets).toEqual([
    { name: 'avatars', visibility: 'public' },
    { name: 'attachments', visibility: 'private' },
  ])
  expect(manifest.realtime).toBe(true)
  expect(manifest.env.server).toEqual([
    { key: 'STRIPE_KEY', required: true },
    { key: 'LOG_LEVEL', required: false },
  ])
  expect(manifest.env.client).toEqual([
    { key: 'PUBLIC_APP_NAME', required: true },
  ])
})

test('buildManifest handles the zero-config app', () => {
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    realtime: false,
  })
  expect(manifest.buckets).toEqual([{ name: 'default', visibility: 'private' }])
  expect(manifest.env).toEqual({ server: [], client: [] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/bunderstack && bun test src/manifest.test.ts`
Expected: FAIL — `./manifest` module not found.

- [ ] **Step 3: Implement**

Create `packages/bunderstack/src/manifest.ts`:

```ts
// src/manifest.ts — deploy-time introspection surface. Pure: consumes already
// resolved config pieces, never reads process.env or touches the network.
// Deployment platforms (Bunderhost) import the app declaration with
// BUNDERSTACK_INTROSPECT=1 and read `app.manifest` to learn what to provision.
import type { ZodType } from 'zod'

import type { Dialect } from './dialect'
import type { EnvConfigInput } from './env'
import type {
  ResolvedBucket,
  ResolvedStorageBuckets,
} from './storage/buckets'

export type ManifestEnvVar = { key: string; required: boolean }

export type BunderstackManifest = {
  dialect: Dialect
  tables: string[]
  defaultBucket: string
  buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  realtime: boolean
  env: { server: ManifestEnvVar[]; client: ManifestEnvVar[] }
}

function describeSection(
  section: Record<string, ZodType> | undefined,
): ManifestEnvVar[] {
  return Object.entries(section ?? {}).map(([key, schema]) => ({
    key,
    required: !schema.safeParse(undefined).success,
  }))
}

export function buildManifest(args: {
  schema: Record<string, unknown>
  dialect: Dialect
  storage: ResolvedStorageBuckets
  envConfig: EnvConfigInput | undefined
  realtime: boolean
}): BunderstackManifest {
  return {
    dialect: args.dialect,
    tables: Object.keys(args.schema),
    defaultBucket: args.storage.defaultBucket,
    buckets: [...args.storage.buckets.values()].map((bucket) => ({
      name: bucket.name,
      visibility: bucket.visibility,
    })),
    realtime: args.realtime,
    env: {
      server: describeSection(args.envConfig?.server),
      client: describeSection(args.envConfig?.client),
    },
  }
}
```

(If `ResolvedBucket` isn't exported from `./storage/buckets` yet, add `export` to its type declaration — check `buckets.ts:55`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/bunderstack && bun test src/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/manifest.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/storage/buckets.ts
git commit -m "feat(bunderstack): buildManifest — deploy-time introspection of app declaration"
```

---

### Task 5: Wire manifest + introspect-safe boot into createBunderstack

**Files:**
- Modify: `packages/bunderstack/src/index.ts` (type `BunderstackApp` at :69, `createBunderstack` body at :144-320, re-exports at the bottom)
- Test: `packages/bunderstack/src/index.test.ts`

**Interfaces:**
- Consumes: `buildManifest`, `BunderstackManifest` from Task 4; lenient `validateEnv` from Task 3.
- Produces: `app.manifest: BunderstackManifest` on every app; `BUNDERSTACK_INTROSPECT=1` boot that (a) forces `database.url` to `':memory:'` (valid for both dialects, see Global Constraints), (b) never creates Redis clients, (c) tolerates missing user env (via Task 3). Re-exports `BunderstackManifest` and `buildManifest` from the package root.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/index.test.ts` (reuse the file's existing schema fixture and imports; add `z` import if missing):

```ts
test('app.manifest describes the declaration', async () => {
  const app = await createBunderstack({
    schema,
    database: { url: ':memory:' },
    env: { server: { WEBHOOK_SECRET: z.string().optional() } },
    storage: { local: './tmp-manifest-uploads', buckets: { avatars: { visibility: 'public' } } },
  })
  expect(app.manifest.dialect).toBe('sqlite')
  expect(app.manifest.buckets).toEqual([{ name: 'avatars', visibility: 'public' }])
  expect(app.manifest.realtime).toBe(false)
  expect(app.manifest.env.server).toEqual([
    { key: 'WEBHOOK_SECRET', required: false },
  ])
})

test('BUNDERSTACK_INTROSPECT=1 boots offline despite remote url and missing env', async () => {
  process.env.BUNDERSTACK_INTROSPECT = '1'
  try {
    const app = await createBunderstack({
      schema,
      // Hardcoded remote URL must NOT be contacted during introspection.
      database: { url: 'libsql://nonexistent-introspect.turso.io', authToken: 'x' },
      env: { server: { STRIPE_KEY: z.string() } }, // required and missing
      realtime: true, // must not require Redis
    })
    expect(app.manifest.env.server).toEqual([
      { key: 'STRIPE_KEY', required: true },
    ])
    expect(app.manifest.realtime).toBe(true)
  } finally {
    delete process.env.BUNDERSTACK_INTROSPECT
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/bunderstack && bun test src/index.test.ts`
Expected: FAIL — `app.manifest` is undefined in the first test. The second test also fails: env validation is already lenient (Task 3), so it gets past that and dies either on the unreachable libsql URL or on `manifest` being undefined. Any failure is fine — red is red.

- [ ] **Step 3: Implement**

In `packages/bunderstack/src/index.ts`:

a) Import at the top:

```ts
import { buildManifest, type BunderstackManifest } from './manifest'
```

b) Add to the `BunderstackApp` type (after the `email` field):

```ts
  /** Deploy-time introspection: what this app needs provisioned. */
  manifest: BunderstackManifest
```

c) In `createBunderstack`, right after `const config = resolveConfig(options, env)`:

```ts
  // Introspection mode (BUNDERSTACK_INTROSPECT=1): deployment platforms import
  // the app declaration only to read `app.manifest`. The boot must never touch
  // the outside world — force an in-memory db (':memory:' is valid for both
  // dialects) and skip Redis below. Env validation is already lenient (env.ts).
  const introspect = process.env.BUNDERSTACK_INTROSPECT === '1'
  if (introspect) {
    config.database.url = ':memory:'
    config.database.authToken = undefined
  }
```

d) Guard the Redis branch — change the `redisUrl` computation:

```ts
  const redisUrl =
    config.realtime && !introspect
      ? resolveRealtimeRedisUrl(config.realtime, env)
      : undefined
```

(The existing `broker` ternary then naturally falls back to the local in-process broker.)

e) Add `manifest` to the returned `app` object literal:

```ts
    manifest: buildManifest({
      schema: options.schema,
      dialect,
      storage: config.storage,
      envConfig: options.env as EnvConfigInput | undefined,
      realtime: Boolean(config.realtime),
    }),
```

f) Re-export at the bottom, next to the existing `resolveConfig` export block:

```ts
export { buildManifest } from './manifest'
export type { BunderstackManifest, ManifestEnvVar } from './manifest'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/bunderstack && bun test src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full package suite (guard against regressions)**

Run: `cd packages/bunderstack && bun test`
Expected: PASS, same set green as on main (integration tests needing external creds skip as usual; compare against the pre-existing-failures baseline, not zero).

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/index.ts packages/bunderstack/src/index.test.ts
git commit -m "feat(bunderstack): app.manifest + BUNDERSTACK_INTROSPECT offline boot mode"
```

---

### Task 6: Document the platform contract

**Files:**
- Modify: `packages/bunderstack/README.md` (add a section; if the README structure differs, place it after the env/config documentation section)

**Interfaces:**
- Consumes: everything above; documentation only.

- [ ] **Step 1: Write the docs section**

Add to `packages/bunderstack/README.md`:

```markdown
## Platform deployment contract

Deployment platforms (like Bunderhost) integrate with any bunderstack app
through env vars alone — no code changes required.

### Overrides (beat code-level config)

| Var | Effect |
| --- | --- |
| `BUNDERSTACK_DATABASE_URL` | Database URL; wins over `database.url` in code |
| `BUNDERSTACK_DATABASE_AUTH_TOKEN` | Auth token for the database |
| `BUNDERSTACK_S3_ENDPOINT` | Forces ALL buckets onto this S3 backend (code-level `local`/per-bucket `s3` blocks are ignored) |
| `BUNDERSTACK_S3_BUCKET` | Physical bucket name (logical buckets become key prefixes) |
| `BUNDERSTACK_S3_ACCESS_KEY_ID` / `BUNDERSTACK_S3_SECRET_ACCESS_KEY` | Credentials |
| `BUNDERSTACK_S3_REGION` | Region (default `auto`) |
| `BUNDERSTACK_S3_PUBLIC_URL` | Public base URL for `visibility: 'public'` buckets |

Plain `DATABASE_URL` / `S3_*` vars keep their usual role: fallbacks that
code-level config wins over.

### Introspection

Set `BUNDERSTACK_INTROSPECT=1` and import the app declaration: the boot is
guaranteed offline (in-memory database, no Redis) and missing user env vars
don't throw. Then read `app.manifest`:

​```ts
process.env.BUNDERSTACK_INTROSPECT = '1'
const { app } = await import('./src/bunderstack')
console.log(JSON.stringify(app.manifest))
// { dialect, tables, defaultBucket, buckets, realtime, env: { server, client } }
​```
```

(Remove the zero-width escapes around the inner code fence when pasting.)

- [ ] **Step 2: Verify formatting**

Run: `cd packages/bunderstack && bun x markdownlint-cli2 README.md || true`
Expected: no NEW errors versus main (the `|| true` keeps a missing linter from blocking; visual check suffices).

- [ ] **Step 3: Commit**

```bash
git add packages/bunderstack/README.md
git commit -m "docs(bunderstack): platform deployment contract (overrides + introspection)"
```
