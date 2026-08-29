# Declarative Bunderstack runtime and testing

Bunderstack will separate an application's declaration from its runtime. A
single `bunderstack({...})` call describes the production application without
opening connections or reading process state. That declaration is then used to
generate deployment metadata, start production runtimes, and create isolated
test fixtures.

The change removes the need for every application to wrap
`createBunderstack()` in its own test-aware factory. Bunderstack owns framework
infrastructure in tests; applications retain only helpers that express their
own domain semantics.

## Goals

- One application declaration shared by production, Blueprint generation, and
  tests.
- No user-written `makeApp(databaseUrl, processEnv)` convention.
- No duplicated or test-only Bunderstack configuration.
- Blueprint generation without starting an application or mutating
  `process.env`.
- Hermetic, concurrent-safe test instances with deterministic cleanup.
- Real auth, API, access, middleware, hooks, jobs, and schema in tests.
- Typed in-process oRPC calls through `app.handler`.
- Deterministic background-job execution without polling or wall-clock sleeps.

## Non-goals

- A test runner, assertion library, or general mocking framework.
- Fakes for application-specific services such as Fly, GitHub, Turso, or an AI
  provider.
- A generic Better Auth plugin harness. The framework helper covers only
  capabilities guaranteed by the configured HTTP surface.
- Runtime selection between different deployment topologies. The declaration's
  database dialect, resource types, jobs, buckets, and providers are static.
- Backward compatibility with the current `createBunderstack()` contract. The
  package is in beta and will make a clean break.

## Public model

The root package exports `bunderstack()` in place of
`createBunderstack()`:

```ts
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'

export const backend = bunderstack({
  schema,
  access,
  database: {
    adapter: libsql(),
    migrations: './migrations',
  },
  env: envSchema,
  auth: authConfig,
  email: {
    provider: 'resend',
    from: 'App <hello@example.com>',
  },
  storage,
  realtime: true,
  api,
  jobs: defineJobs,
})
```

`bunderstack()` is synchronous and side-effect free. It returns a reusable
backend declaration, not an application runtime:

```ts
export type BunderstackBackend<TApp extends BunderstackApp> = {
  readonly manifest: BunderstackManifest
  start(options?: StartOptions): Promise<TApp>
  test(options?: TestOptions): Promise<TestFixture<TApp>>
}
```

The exact generic parameters remain derived from the schema, access, storage,
env, jobs, API, and realtime declaration as they are today. `TApp` is the
existing fully inferred `BunderstackApp<...>` runtime type.

The declaration is branded with a private symbol. Blueprint generation and
other framework tooling validate that brand instead of accepting arbitrary
objects with a `manifest` property.

### Production entry

Starting the application is an explicit second phase:

```ts
// src/server.ts
import { backend } from './backend'

export const app = await backend.start()

Bun.serve({ fetch: app.handler })
```

`.start()` defaults to `process.env`. Embedders may supply a complete source:

```ts
const app = await backend.start({
  env: {
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: authSecret,
    ADMIN_TOKEN: adminToken,
  },
})
```

An explicit `env` is the entire environment source. It is never merged with
`process.env`. This preserves hermetic embedding and prevents absent values
from being filled by unrelated process state.

Every call to `.start()` creates an independent runtime with its own lifecycle.
Closing one runtime does not affect the declaration or any sibling runtime.

### Module layout

Templates separate declaration from startup:

```text
src/backend.ts  exports backend; safe to import from tests and tooling
src/server.ts   imports backend, calls backend.start(), starts the server
```

The declaration module must not also call `backend.start()`. This prevents a
test or Blueprint import from booting a production singleton as a module side
effect.

## Static topology and runtime values

Deployment-affecting structure is fixed by `bunderstack({...})`:

- database adapter, driver, and dialect;
- migration directory;
- schema tables;
- storage buckets and visibility;
- email provider;
- whether realtime is required;
- job and cron definitions;
- declared environment keys.

Configuration factories may configure runtime behavior, but may not choose
between deployment resource shapes. This remains valid because it does not
alter topology:

```ts
auth: ({ db, env }) => ({
  secret: env.AUTH_SECRET,
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await db.insert(profile).values({ userId: user.id })
        },
      },
    },
  },
})
```

Topology branching is not part of the public config contract:

```ts
// Invalid: the Blueprint cannot describe one deterministic database resource.
database: ({ env }) =>
  env.USE_POSTGRES
    ? { adapter: bunSql() }
    : { adapter: libsql() }
```

Bunderstack does not introduce a general `env()` reference DSL in this change.
Framework resources use their established environment conventions:

- `DATABASE_URL` and `DATABASE_AUTH_TOKEN` for the database;
- `BUNDERSTACK_EMAIL_FROM` and the provider-specific secret for email;
- `REDIS_URL` for the Redis realtime transport;
- the declared `env.server` and `env.client` schemas for application values.

Provider choice is static. Secrets and connection values are resolved only by
`.start()` or `.test()`.

The existing managed-host email override is a deliberate infrastructure
substitution, not application branching. An application declares that it uses
the Bunderstack email capability; a host may replace capture delivery with its
managed Resend adapter through the reserved `BUNDERSTACK_EMAIL_PROVIDER`
contract. The host owns and injects the corresponding secret. This is the same
class of substitution as `.test()` replacing Resend with capture: neither
changes the application's schema, hooks, or email calls. Application code may
not inspect a secret and choose its own provider. Bunderhost's control plane,
for example, migrates from `RESEND_API_KEY ? 'resend' : 'console'` to one static
provider declaration and lets its test fixture substitute capture delivery.

## Manifest and Blueprint generation

The manifest moves from the runtime to the backend declaration. It is built
synchronously from static configuration:

```ts
backend.manifest
```

`bunderstack blueprint` imports the configured entry and expects a branded
`backend` export:

```ts
const module = await import(entryUrl)
if (!isBunderstackBackend(module.backend)) {
  throw new Error(`[bunderstack] ${entry} must export backend`)
}
const manifest = parseManifest(module.backend.manifest)
```

The generator no longer sets `BUNDERSTACK_INTROSPECT`, constructs a mock
database, creates Better Auth, starts lifecycle machinery, or calls
`app.close()`.

The committed Blueprint shape remains version 1 and the manifest remains
version 3 as long as their serialized fields do not change:

```yaml
version: 1
bunderstack:
  entry: src/backend.ts
  manifestVersion: 3
```

`bunderstack.entry` now means "the module exporting the backend declaration."
The template's `package.json` points it at `src/backend.ts`. Bunderhost updates
its validation error from "must export app" to "must export backend". The
Blueprint continues to describe production topology; test substitutions never
change it.

## Test fixture

The declaration creates a fixture directly:

```ts
import { expect, test } from 'bun:test'
import { backend } from './backend'

test('creates a project', async () => {
  await using t = await backend.test({
    env: { ADMIN_TOKEN: 'test-admin-token' },
  })

  const alice = await t.auth.signUpEmail({
    email: 'alice@example.test',
    name: 'Alice',
  })

  const project = await t.client(alice).projects.create({ name: 'Alpha' })
  expect(project.name).toBe('Alpha')
})
```

The fixture surface is composed of focused capabilities:

```ts
export type TestFixture<TApp extends BunderstackApp> = AsyncDisposable & {
  readonly app: TApp
  readonly auth: TestAuth
  readonly email: TestEmail
  readonly storage: TestStorage
  readonly jobs: TestJobs
  client(identity?: TestIdentity): BunderstackClient<TApp>
  close(): Promise<void>
}
```

`TestFixture[Symbol.asyncDispose]()` delegates to `close()`. Cleanup is
idempotent and ordered:

1. stop workers and close the Bunderstack runtime;
2. close infrastructure adapters;
3. delete temporary database and storage resources.

There is no global resource registry, Bun preload, or implicit `afterEach`.
Lexical ownership makes `test.concurrent` safe. Code that cannot use
`await using` calls `await t.close()` explicitly.

The root implementation may load the fixture implementation through a static
literal dynamic import so production startup does not eagerly load test-only
filesystem and adapter code. The public types contain no dependency on
`bun:test`; the fixture relies only on standard `AsyncDisposable`.

### Hermetic test environment

`.test()` starts with framework-owned defaults:

```ts
{
  NODE_ENV: 'test',
  AUTH_SECRET: 'bunderstack-test-secret',
  BUNDERSTACK_ROLE: 'web',
}
```

The explicit `TestOptions.env` is merged only with those defaults, never with
`process.env`. Required application variables remain required. Missing
`ADMIN_TOKEN`, for example, produces the same environment validation error as
production.

## Infrastructure substitution

`.test()` may substitute only framework infrastructure. It must not accept a
partial production `BunderstackConfig`, because changing schema, auth, access,
API, middleware, or jobs would recreate configuration drift.

Default substitutions are:

| Production capability | Test implementation |
| --- | --- |
| libSQL | isolated memory database, or a temporary file when requested |
| PGlite | isolated memory database, or a temporary directory when requested |
| external PostgreSQL | no implicit target; requires an explicit test strategy |
| local or S3 storage | isolated temporary/in-memory storage adapter |
| Resend, SMTP, or console email | capture adapter |
| Redis realtime | process-local memory transport |
| background worker | `autoStart: false` |

Better Auth, access rules, middleware, hooks, schema, API procedures, job
handlers, and lifecycle callbacks are the production declarations.

### Database test capability

Database adapters may declare how to create an isolated test target:

```ts
export type DatabaseAdapter = {
  readonly dialect: Dialect
  readonly driver: Driver
  connect<TSchema extends Record<string, unknown>>(
    schema: TSchema,
    connection: DatabaseConnection,
    options: DatabaseConnectOptions,
  ): Promise<DatabaseConnectionResult<TSchema>>
  migrate(db: AnyDb, migrationsFolder: string): Promise<void>
  testing?: {
    createTarget(options: {
      mode: 'memory' | 'temporary'
    }): Promise<TestDatabaseTarget>
  }
}

export type TestDatabaseTarget = AsyncDisposable & {
  connection: DatabaseConnection
}
```

The ordinary built-in case requires no options:

```ts
await using t = await backend.test()
```

Schema installation defaults to the same auto mode as `provision()`: apply
committed migrations when a journal exists, otherwise push the schema with
`force: true` into the newly empty database. Callers may require an exact mode:

```ts
await using t = await backend.test({
  database: {
    mode: 'temporary',
    schema: 'migrations',
  },
})
```

External PostgreSQL adapters cannot derive a safe target from a production
URL. They require an explicit strategy, such as a strategy that creates and
drops a unique PostgreSQL schema:

```ts
await using t = await backend.test({
  database: {
    strategy: postgresTestSchema({ url: testDatabaseUrl }),
    schema: 'migrations',
  },
})
```

If no safe strategy is available, `.test()` fails before connecting. It never
falls back to the declared production URL.

### Email and storage observation

The email capture adapter exposes messages after the complete Bunderstack email
pipeline, including resolved sender and journaling:

```ts
await t.client(alice).invitations.create({ email: 'bob@example.test' })

expect(t.email.sent).toContainEqual({
  to: ['bob@example.test'],
  subject: 'You were invited',
})
```

Test storage preserves the production storage facade and adds read-only
inspection helpers:

```ts
await t.app.storage.upload('avatars/alice.png', bytes, 'image/png')
expect(await t.storage.read('avatars/alice.png')).toEqual(bytes)
```

Custom framework adapters may implement the same `testing` capability pattern.
Application-specific service clients remain ordinary application dependencies
and use domain-specific fakes.

## Authentication

The generic auth helper does not assume Better Auth organization support.
`signUpEmail()` calls the real `/api/auth/sign-up/email` endpoint through
`app.handler`, captures response cookies, and returns a transport identity:

```ts
export type TestIdentity = {
  user: {
    id: string
    email: string
    name: string
  }
  headers: Headers
}

const alice = await t.auth.signUpEmail({
  email: 'alice@example.test',
  password: 'password-123',
  name: 'Alice',
})
```

The default password is documented and test-only. A non-success auth response
throws `TestAuthError` containing the status and response body.

Because the helper uses HTTP, it exercises Better Auth hooks and avoids the
plugin-specific methods erased from the published `Auth` type. Applications
query organizations and other plugin concepts through their own typed API:

```ts
const organizations = await t.client(alice).organizations.list()
```

`mockAuthSession` remains available under `bunderstack/testing` for tests that
do not care how a user was created. `t.auth.mockSession(user)` wraps it and
returns a `TestIdentity` suitable for `t.client(identity)`.

## Typed in-process client

`t.client()` reuses the existing `createClient<TApp>()` implementation:

```ts
createClient<TApp>({
  baseUrl: 'http://bunderstack.test/api',
  fetch: (input, init) => app.handler(new Request(input, init)),
  headers: identity?.headers,
})
```

Calls therefore traverse the real oRPC transport, request context, auth,
middleware, and handler without binding a TCP port. Router inference comes from
the existing `$inferClient` carrier, so no router `any` cast is needed.

## Deterministic jobs

The design does not add an ambiguous `settle()` method to the production jobs
facade. Test fixtures expose two explicit operations:

```ts
export type TestJobs = {
  runNext(options?: { now?: Date }): Promise<JobRunReport>
  runUntilIdle(options?: {
    now?: Date
    maxTicks?: number
    failOnJobError?: boolean
  }): Promise<JobRunReport>
}
```

`runNext()` performs one complete queue tick at the supplied time.

`runUntilIdle()` repeatedly ticks at one fixed `now` until no runnable job
remains. Its contract is:

- jobs with `runAt <= now` are runnable;
- jobs enqueued by handlers are included when runnable at the same `now`;
- delayed jobs and retries with `runAt > now` remain pending;
- time never advances implicitly;
- future cron slots are not materialized;
- `maxTicks` defaults to 100 and prevents infinite recursive enqueue;
- `failOnJobError` defaults to true;
- a terminal failure throws `TestJobsError` with job IDs, names, attempts, and
  last errors;
- the report aggregates claimed, ran, failed, and remaining runnable counts.

Tests advance time explicitly:

```ts
await t.app.jobs.enqueue('sendReminder', input, { delay: 60_000 })

expect(
  await t.jobs.runUntilIdle({ now: new Date('2026-08-27T10:00:00Z') }),
).toMatchObject({ ran: 0 })

expect(
  await t.jobs.runUntilIdle({ now: new Date('2026-08-27T10:01:00Z') }),
).toMatchObject({ ran: 1 })
```

The queue's inspection required to distinguish idle from future work stays on
a testing-only internal handle. Production `app.jobs` retains `enqueue()` and
`tick()` without test methods.

## Error handling

- Declaration validation errors are thrown synchronously by `bunderstack()`.
- Environment validation and runtime connection errors are thrown by `.start()`
  or `.test()` before a runtime is returned.
- Any partial runtime creation closes connections and temporary resources. If
  creation and cleanup both fail, the caller receives an `AggregateError`.
- Fixture cleanup attempts every resource close and aggregates failures rather
  than abandoning later resources.
- `TestAuthError` preserves HTTP status and response body.
- `TestJobsError` preserves the jobs that failed or prevented convergence.
- `runUntilIdle()` reports a distinct convergence error after `maxTicks`; it
  does not describe that condition as an ordinary job failure.

## Package boundaries

- `bunderstack` exports `bunderstack`, backend/runtime types, and production
  runtime APIs.
- `bunderstack/testing` exports fixture types, explicit `createTestApp(backend)`
  for advanced composition, auth/job test helpers, database test strategies,
  and `mockAuthSession`.
- `backend.test()` is the ergonomic delegate to the testing implementation.
- Importing `bunderstack` does not import `bun:test` and does not register test
  hooks.
- Test code is absent from production's eagerly evaluated module graph.

## Migration

The migration is intentionally direct:

```ts
// Before
export function makeApp(databaseUrl?, processEnv?) {
  return createBunderstack({
    schema,
    access,
    database: { adapter: libsql(), url: databaseUrl },
    processEnv,
    auth,
    api,
    jobs,
  })
}
export const app = await makeApp()
```

```ts
// After: backend.ts
export const backend = bunderstack({
  schema,
  access,
  database: { adapter: libsql() },
  auth,
  api,
  jobs,
})

// After: server.ts
export const app = await backend.start()
```

Framework tests migrate from direct runtime construction to declarations plus
lexically owned fixtures. The template migrates first as the public reference.
Bunderhost is the first substantial application consumer and deletes its test
app, resource registry, preload, and generic auth/RPC/job harness code. Its
Fly, Turso, Tigris, and GitHub fakes remain.

Other surveyed applications migrate after the framework and bunderhost prove
the contract. Their domain-specific helpers are evaluated individually rather
than deleted mechanically.

## Verification and acceptance

The implementation is accepted when all of the following hold:

1. Importing a backend declaration performs no database, filesystem, network,
   worker, or global environment mutation.
2. Blueprint generation reads `backend.manifest` without
   `BUNDERSTACK_INTROSPECT` and produces the expected committed YAML.
3. Two concurrent fixtures from one backend use independent database and
   storage state; closing either leaves the other usable.
4. `await using` closes the runtime and removes temporary resources on success
   and exception paths.
5. Explicit test env never inherits a value from `process.env`.
6. Tests cannot override schema, access, auth, API, middleware, or jobs through
   `TestOptions`.
7. Email sign-up exercises the real auth handler and its user-create hook.
8. The in-process client retains positive and negative compile-time router
   inference tests in emitted consumer declarations.
9. Job tests cover immediate work, recursive enqueue, delayed work, retries,
   terminal failure, and max-tick non-convergence without sleeps.
10. libSQL and PGlite fixtures provision in both push and committed-migrations
    modes.
11. External PostgreSQL refuses to use a production URL without an explicit
    test strategy.
12. Production bundles do not eagerly contain fixture implementation code or
    `bun:test`.
13. The template, framework suite, and bunderhost use the new declaration and
    fixture model without a project-level Bunderstack test harness.

## Deferred possibilities

- A reusable test-container strategy for server PostgreSQL.
- Additional Better Auth plugin helpers under dedicated typed entry points.
- A public production queue-drain operation, if a non-test use case develops.
- A general environment-reference DSL, if conventional framework keys prove
  insufficient for future static resource adapters.
