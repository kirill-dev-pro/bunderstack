# Runtime replacements

Current snippets for each capability a migration moves onto Bunderstack. Adapt
names; do not change the contracts.

## Modular entry

A migrated application has enough configuration to justify `src/bunderstack/`
with `backend.ts`, `index.ts`, `schema/`, `access.ts`, `auth.ts`, `env.ts`,
`jobs/`, and `api/`. The declaration is the only place that assembles them:

```ts
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { access } from './access'
import { authConfig } from './auth'
import { envSchema } from './env'
import { defineJobs } from './jobs'
import { schema } from './schema'
import * as v from 'valibot'

export const backend = bunderstack({
  schema,
  access,
  env: envSchema,
  database: {
    adapter: libsql(),
    url: 'file:./data.db',
  },
  auth: authConfig,
  email: { from: 'App <no-reply@example.com>' },
  storage: {
    local: './uploads',
    defaultBucket: 'files',
    buckets: {
      files: {
        visibility: 'private',
        access: { create: 'authenticated', get: 'owner', delete: 'owner' },
      },
    },
  },
  realtime: true,
  jobs: defineJobs,
  middleware: [instrumentation],
  api,
})

// api/base.ts — the builder is a module value, so router modules import the
// bases they need instead of receiving them through the config callback.
//
//   export const o = defineApi({ schema, env: envSchema })
//   export const protectedProcedure = o.protected
//   export const instrumentation = o.middleware(async ({ next }) => next())
//
// api/index.ts — plain objects, no factories.
//
//   export const api = { projects: projectsRouter }

// index.ts
import { provision } from 'bunderstack/provision'
import { backend } from './backend'

export const app = await backend.start()
export const { db, auth, env } = app
export type App = typeof app

await provision(app)
```

The database adapter is imported explicitly; there is no implicit driver. Keep
unrelated external side effects out of the backend import graph. The blueprint
imports the declaration and reads `backend.manifest`; it never starts the app,
connects to a queue, or needs a special environment flag.

Aggregate every domain, Better Auth, plugin, and internal table in the schema
object, including `export * from 'bunderstack/schema'`, so migrations cover the
internal tables.

## Auth

Export a plain `authConfig` and pass it in. Never construct a second Better
Auth instance, a custom session resolver, or a monkey-patched `getSession`;
consumers import `app.auth`.

`src/bunderstack/auth.ts` reads `process.env` directly at module scope rather
than importing the entry, and uses a dynamic `import('./index')` inside async
callbacks such as email rendering. Importing the entry from `auth.ts` creates a
circular evaluation loop at boot.

## TanStack Start route

One catch-all route, built by the adapter rather than by hand:

```ts
import { createApiHandlers } from 'bunderstack/start'
import { createFileRoute } from '@tanstack/react-router'
import { app } from '../../bunderstack'

export const Route = createFileRoute('/api/$')({
  server: { handlers: createApiHandlers(app) },
})
```

Delete `/api/auth/$`, `/api/trpc/$`, and `/api/cron/*`. The catch-all serves
Better Auth plus the unified oRPC graph at `/api/rpc/*`. A more specific file
route wins over the catch-all, so any survivor keeps serving the legacy path.
Other runtimes adapt their request and response objects to the Web Standard
pair and delegate to `app.handler`; a standalone Bun process uses
`Bun.serve({ fetch: app.handler })`.

## Worker

Production queue work is its own process:

```ts
// src/worker.ts
import { backend } from './bunderstack/backend'

const app = await backend.start({
  env: { ...process.env, BUNDERSTACK_ROLE: 'web' },
})
await app.runWorker()
```

Run it with `bun src/worker.ts` as a separate process command. Do not start a
production worker or cron scheduler from the web entry: every web replica would
run its own worker and compete for the same jobs.

`runWorker()` refuses to start when jobs could publish realtime events over the
in-memory broker, because a separate process cannot reach web subscribers
through it. Configure the same `REDIS_URL` (or `realtime.redis`) for web and
worker. The embedded `app.startWorker()` remains correct for local development
and single-process deployments that acknowledge process-local realtime; pass
`allowProcessLocalRealtime: true` only when the worker genuinely never
publishes.

## Jobs and cron

```ts
import * as v from 'valibot'

export const defineJobs = (jobs) =>
  jobs.define({
    generateReport: jobs.job({
      input: v.object({ reportId: v.pipe(v.string(), v.minLength(1)) }),
      concurrency: 1,
      timeout: 10 * 60_000,
      handler: async ({ reportId }, ctx) => buildReport(reportId, ctx),
      onFailed: async ({ reportId }, error, ctx) =>
        markFailed(reportId, error, ctx),
    }),
    archiveStale: jobs.cron({
      // A cron handler receives the invocation first, then the job context.
      schedule: '0 3 * * *',
      handler: async (_invocation, ctx) => archiveStale(ctx),
    }),
  })
```

Enqueue with `app.jobs.enqueue('generateReport', { reportId })`. Queue handlers
are at-least-once, so make them idempotent. `jobs.cron()` is delivered by the
platform over authenticated HTTP and appears in the blueprint; a hand-rolled
`/api/cron/*` route with a shared secret is invisible to the host and is
replaced, not kept alongside.

## Direct realtime writes

Generated CRUD publishes automatically. A write through `app.db` or `ctx.db`
publishes explicitly, with the table object and the complete returned row,
after the transaction commits:

```ts
const [task] = await ctx.db
  .update(schema.tasks)
  .set({ status: 'done' })
  .where(eq(schema.tasks.id, taskId))
  .returning()

await ctx.realtime.publish(schema.tasks, 'update', task)
```

The complete row is required so the access filter can evaluate owner and
read-scope columns. Do not publish from inside an enclosing transaction, and do
not publish a partial patch.

Clients subscribe through the typed `realtime.changes` async iterator. Its
transport emits an internal `heartbeat` during idle periods; the official
query client consumes it automatically without updating cache state or the
Publisher resume ID. Delete custom polling, keepalive, SSE registration, and
client reconnect loops instead of wrapping them around the oRPC stream.

For TanStack DB applications, use `bunderstack/sync`. Successful mutations are
reconciled from their complete server response without a follow-up `list`
refetch, and same-row updates are coalesced while a request is in flight.

## Access

Replace per-endpoint session checks and hand-written SQL filters with
`defineAccess(schema, rules)`:

```ts
export const access = defineAccess(schema, {
  projects: {
    list: 'authenticated',
    get: 'owner',
    create: 'authenticated',
    update: 'owner',
    delete: 'owner',
    ownerColumn: 'ownerId',
    scope: { read: (ctx) => ({ ownerId: ctx.user?.id ?? '__none__' }) },
  },
  appLogs: { crud: false },
})
```

Keep auth, internal, and administrative tables out of generated CRUD. Use
`o.protected` procedures when authorization depends on a related row or a
role; hiding a UI route is not authorization.

## Storage

```ts
await app.storage.upload(key, body, contentType, { bucket: 'files' })
const url = await app.storage.getUrl(key, { expiresIn: 3600 })
await app.storage.delete(fileId)
```

Buckets are declared in `bunderstack()` with their own visibility and
access rules. Delete the AWS or Tigris wrapper and uninstall the SDK. A custom
multipart upload route is replaced by the bucket's own upload route unless it
performs domain work that cannot move into a job.

## Email

```ts
await app.email.send({ to, subject, html })
```

Configure `email: { from, provider }`. `provider` defaults to `resend` when
`RESEND_API_KEY` is set and `console` in development. The facade uses Web
Standard `fetch`, so the `resend` package is uninstalled.

## Env

Pass `envSchema` to `bunderstack({ env: envSchema })` and read `app.env`
or `ctx.env`. Remove `@t3-oss/env-core` `createEnv()` calls and `dotenv`; Bun
loads `.env` itself. Server variables must not use the `PUBLIC_` prefix, and
browser-safe variables must. Declared env appears in the deployment blueprint,
which is how the host learns what the application needs. Commit `.env.example`
with names and safe placeholders only.

## Provisioning, migrations, and blueprint

`provision(app)` uses the development schema-push loop while no `migrations/`
folder exists, and applies committed migrations once one does. Generate and
commit migrations before production:

```json
{
  "bunderstack": { "entry": "src/bunderstack/backend.ts" },
  "scripts": {
    "worker": "bun src/worker.ts",
    "db:generate": "drizzle-kit generate",
    "blueprint": "bunderstack blueprint",
    "blueprint:check": "bunderstack blueprint --check"
  }
}
```

`bun run blueprint` regenerates the committed `bunderstack.blueprint.yaml` from
the entry; `bun run blueprint:check` must pass in CI so the committed
declaration matches the application. Never commit secrets, databases, uploads,
or build output.

## Test and script ownership

A test or script owns its fixture lexically:

```ts
await using t = await backend.test({ database: { schema: 'push' } })
const identity = t.auth.mockSession({
  id: 'user-1',
  email: 'dev@example.com',
  name: 'Developer',
})
const client = t.client(identity)
// ...
```

The fixture isolates database, email, storage, realtime, and queue state and is
disposed at the end of the block. Keep application-specific organization setup
in a typed helper layered on top of the base user/session auth helper.
