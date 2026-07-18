# Bunderstack Background Runtime and Bunderhost Deployment Design

**Date:** 2026-07-18
**Status:** approved through brainstorming

## Goal

Make a Bunderstack declaration safe to import as a TanStack Start event
listener while preserving a one-call local worker API and giving Bunderhost a
declarative contract for deploying durable queue workers and scheduled tasks.

## Core decisions

1. `createBunderstack()` assembles an application. It does not start polling
   loops, storage sweep timers, cron timers, or Redis subscriptions.
2. `app.handler` is a Web Standard `Request -> Response` listener. TanStack
   Start owns the HTTP process and calls it through `createApiHandlers(app)`.
3. Queue jobs and cron tasks are different declarations and different runtime
   roles.
4. Queue jobs require an explicitly started worker. Bunderhost makes the
   additional always-on Machine visible in the deployment model.
5. Cron tasks are dispatched by Bunderhost as signed HTTP requests. The request
   wakes a scale-to-zero web Machine; no per-application cron Machine is needed.
6. Preview environments do not run queue workers or receive cron dispatches by
   default.
7. Standalone Bun applications keep using `Bun.serve({ fetch: app.handler })`.
   Bunderstack does not wrap `Bun.serve`.

## Application API

The shared declaration remains the only application-specific entrypoint:

```ts
export const app = await createBunderstack({
  schema,
  access,
  jobs: (j) =>
    j.define({
      sendReceipt: j.job({
        input: z.object({ orderId: z.string() }),
        retries: 5,
        handler: async ({ orderId }, ctx) => {
          await sendReceipt(ctx, orderId)
        },
      }),
      removeExpiredSessions: j.cron({
        schedule: '0 * * * *',
        handler: async ({ scheduledFor }, ctx) => {
          await removeExpiredSessions(ctx, scheduledFor)
        },
      }),
    }),
})
```

`j.job()` declares input-bearing durable queue work. `j.cron()` declares a
five-field UTC schedule and cannot declare input, retries, backoff, concurrency,
or `onFailed`: delivery retries belong to the platform scheduler.

Only `j.job()` names are accepted by `app.jobs.enqueue()`. Cron names are
excluded at the type level and rejected at runtime.

The runtime surface is:

```ts
type BunderstackApp = {
  handler(req: Request): Promise<Response>
  jobs: JobsFacade
  startWorker(options?: StartWorkerOptions): Promise<WorkerHandle>
  runWorker(options?: RunWorkerOptions): Promise<void>
  startCronScheduler(options?: LocalCronOptions): Promise<CronSchedulerHandle>
  close(): Promise<void>
  readonly status: 'ready' | 'closing' | 'closed'
  readonly signal: AbortSignal
}
```

`startWorker()` is non-blocking and is intended for an embedded development
process. `runWorker()` is the production convenience call: it installs
`SIGINT`/`SIGTERM` handlers when no signal is supplied, runs until aborted, and
then closes the entire application. Supplying a signal avoids installing
process handlers, but `runWorker()` still owns and closes the application;
embedded callers that do not want that ownership use `startWorker()`.
`startCronScheduler()` exists for standalone development only; Bunderhost is
the production clock.

Calling `app.close()` is idempotent. It aborts the shared signal, stops all
registered worker/local-scheduler handles, closes lazy realtime resources, and
rejects new background starts. HTTP hosts remain responsible for stopping their
own server.

## Queue worker semantics

Enqueue remains a database insert and is safe from any HTTP replica. Enqueue
does not wake an in-process runner. A worker uses an async polling loop that
never overlaps its own `tick()` calls. Existing atomic claims, leases, retries,
dedupe keys, concurrency limits, and terminal retention remain intact.

The worker does not evaluate cron expressions. It only claims definitions made
with `j.job()`.

When Bunderhost sees at least one queue job in the manifest, it builds a
companion worker executable and deploys one always-on worker Machine in the
production environment. The worker has no public service and uses restart
policy `always`. During blue-green deployment the new web Machine must become
healthy before the new worker starts. A short overlap between old and new
workers is safe because claims are database-atomic.

## Cron delivery protocol

Bunderhost owns one global scheduler for all customer applications. Every UTC
minute it reads live production manifests, determines due schedules, and sends
user cron to:

```text
POST /api/_bunderstack/cron/<name>
X-Bunderstack-Cron-Slot: <minute-aligned epoch milliseconds>
X-Bunderstack-Cron-Signature: sha256=<hex HMAC>
```

Platform maintenance uses the same protocol at
`POST /api/_bunderstack/maintenance/<name>`. The canonical task identifier is
`cron:<name>` or `maintenance:<name>`, and the signed value is
`<task-identifier>\n<slot>`. This namespace prevents a user cron from colliding
with a platform maintenance task. Each production environment has a random
`BUNDERSTACK_CRON_SECRET`, encrypted by Bunderhost and injected into the web
process. The secret is never included in the public manifest.

Bunderstack validates the signature, the declared name, minute alignment,
freshness (not more than 60 minutes old or one minute in the future), and that
the slot matches the cron expression. It then claims
`(task-identifier, slot)` in an internal `_bunderstack_cron_runs` table. The row
has `running`, `succeeded`, or `failed` status plus a lease. Concurrent delivery
is suppressed; a failed or
expired claim can be retried. A crash after an external side effect but before
marking success can repeat the handler, so handlers must remain idempotent.

Responses are:

- `200 { status: 'succeeded' | 'duplicate' }`
- `202 { status: 'running' }`; Bunderhost retries the slot
- `400` for malformed or schedule-mismatched slots
- `401` for invalid signatures
- `404` for unknown cron names
- `500` when the handler fails; Bunderhost retries the same slot

Built-in storage orphan cleanup is represented as platform maintenance, not as
a queue job. The protected `storage-sweep` endpoint invokes
`app.storage.sweep()` with the same slot-level lease and response semantics as
user cron. Bunderhost may dispatch it on a low-frequency schedule; local
developers can invoke `app.storage.sweep()` or use the local cron scheduler.

## Manifest v2

The manifest becomes explicitly versioned:

```ts
type BunderstackManifest = {
  version: 2
  dialect: Dialect
  // Logical schema keys retained for display and compatibility.
  tables: string[]
  // Only this mapping may be used to form SQL identifiers for app tables.
  tableMap: Record<string, string>
  // Platform-owned physical tables; no consumer may infer these names.
  systemTables: {
    jobs: string
    files: string
    scheduledRuns: string
  }
  defaultBucket: string
  buckets: Array<{ name: string; visibility: 'public' | 'private' }>
  realtime: boolean
  env: { server: ManifestEnvVar[]; client: ManifestEnvVar[] }
  background: {
    jobs: Array<{ name: string }>
    cron: Array<{
      name: string
      schedule: string
      timezone: 'UTC'
    }>
    maintenance: Array<{
      name: 'storage-sweep'
      schedule: string
    }>
  }
}
```

`background.jobs.length > 0` means production needs a worker Machine.
`background.cron` drives Bunderhost HTTP schedules. Bunderhost rejects manifest
versions it does not understand instead of guessing deployment behavior. The
same manifest is the Explorer's allow-list: `tableMap` maps a logical table key
to its physical SQL name, while `systemTables` exposes the physical queue,
storage-metadata, and scheduled-run tables without leaking credentials or
requiring Bunderhost to duplicate library internals.

## Bunderhost build contract

Bunderhost already imports `src/bunderstack.ts` for introspection. For an app
with queue jobs it generates a temporary entrypoint:

```ts
import { app } from '../src/bunderstack.ts'
await app.runWorker()
```

The builder produces `webImage` and optional `workerImage`. A platform-owned
minimal worker Dockerfile compiles the generated entrypoint with Bun and does
not depend on the application's custom web Dockerfile. Cron-only applications
produce no worker image.

The Fly runtime assigns machine metadata `bunderhost.role=web|worker`. Listing
and blue-green cleanup filter by role, so deploying a web Machine never destroys
the current worker. A Deployment records both nullable machine IDs.

## Bunderhost scheduler

Fly's native Machine `schedule` only supports fuzzy hourly/daily/weekly/monthly
intervals, so it is not the source of truth for five-field cron. Bunderhost runs
one global dispatcher process. It records `(environmentId, kind, name, slot)`
in its control database, signs requests with the environment secret, retries
`202`, `5xx`, and network failures with bounded exponential backoff, and never
selects preview environments. Successful application slot rows are retained
for 30 days; Bunderhost retains dispatch audit rows for 90 days.

The scheduler is a platform concern shared by every hosted application. It does
not create an always-on Machine per cron-only customer.

## Failure and rollout rules

- A web deployment must pass HTTP health before worker rollout.
- A failed new worker leaves the previous worker running and fails the
  deployment; the new web Machine is removed.
- Removing all queue jobs removes the production worker after the new web
  deployment is healthy.
- Removing a cron causes scheduler reconciliation to stop future slots; existing
  dispatch history remains for audit.
- Preview manifests remain visible in the dashboard, but background execution is
  marked disabled.
- Bunderstack and Bunderhost ship the manifest-v2 change together; there is no
  backwards-compatibility requirement because the projects have no external
  users yet.

## Validation

Bunderstack tests cover type-level job/cron separation, no background work after
application construction, worker lifecycle and shutdown, cron authentication,
slot claiming/retry, SQLite/Postgres internal tables, manifest v2, and local
scheduling. Manifest tests additionally cover logical-to-physical table mapping
and all three advertised system table names.

Bunderhost tests cover companion worker builds, role-specific Fly Machine
configuration, blue-green web/worker orchestration, production-only background
execution, signed cron delivery and retries, manifest-version rejection, and
worker removal when the last queue job disappears.

## Platform references

- [Fly.io task scheduling](https://fly.io/docs/blueprints/task-scheduling/)
- [Fly Machines resource API](https://fly.io/docs/machines/api/machines-resource/)
