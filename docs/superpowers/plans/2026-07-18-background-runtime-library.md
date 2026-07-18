# Bunderstack Background Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make application construction background-side-effect-free, separate queue jobs from HTTP-dispatched cron tasks, and expose explicit worker/lifecycle APIs.

**Architecture:** `createBunderstack()` constructs request-serving capabilities and typed declarations only. Queue execution moves behind explicit `startWorker()`/`runWorker()` handles; cron execution moves behind an authenticated HTTP router backed by leased per-slot records. A lifecycle registry owns every resource started after construction.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle ORM, libSQL/PGlite/Postgres, Zod, Bun test.

## Global Constraints

- Use Bun commands exclusively.
- Preserve the single Web Standard `app.handler(Request) -> Promise<Response>` integration point.
- Do not wrap `Bun.serve()`.
- Five-field cron expressions use UTC and minute granularity.
- `createBunderstack()` must not start timers, polling loops, or Redis subscriptions.
- Queue jobs remain durable, lease-based, retryable, deduplicated, and safe across replicas.
- Cron handlers are at-least-once and must be documented as idempotent.
- Preview policy belongs to Bunderhost; the library exposes capabilities without detecting preview environments.
- Manifest v2 is intentionally breaking; no manifest-v1 compatibility layer is required.

---

### Task 1: Restore a clean static baseline

**Files:**
- Modify: `packages/bunderstack/src/storage/buckets.test.ts:75`
- Modify: `package.json`

**Interfaces:**
- Consumes: current `ResolvedBucket.readScope` and `ResolvedBucket.writeScope`.
- Produces: root `typecheck` script used by every later task.

- [ ] **Step 1: Correct the stale scope assertion**

Replace the deleted `bucket.scope` assertion with:

```ts
expect(bucket.readScope).toBeUndefined()
expect(bucket.writeScope).toBeUndefined()
```

- [ ] **Step 2: Add the workspace static-check command**

Add this root script:

```json
"typecheck": "bunx tsc --noEmit -p packages/bunderstack/tsconfig.json && bunx tsc --noEmit -p packages/bunderstack-query/tsconfig.json && bunx tsc --noEmit -p packages/bunderstack-sync/tsconfig.json && bunx tsc --noEmit -p packages/bunderstack-start/tsconfig.json"
```

- [ ] **Step 3: Verify the baseline**

Run: `bun run typecheck`

Expected: exit 0 with no diagnostics.

Run: `bun test packages/bunderstack/src/storage/buckets.test.ts`

Expected: all bucket tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json packages/bunderstack/src/storage/buckets.test.ts
git commit -m "chore: restore workspace typecheck gate"
```

### Task 2: Split queue-job and cron declarations

**Files:**
- Modify: `packages/bunderstack/src/jobs/define.ts`
- Modify: `packages/bunderstack/src/jobs/index.ts`
- Modify: `packages/bunderstack/src/jobs/define.test.ts`
- Modify: `packages/bunderstack/src/infer-client.test.ts`

**Interfaces:**
- Consumes: `parseCron()`, `JobContext`, Zod input schemas.
- Produces: `QueueJobDefinition`, `CronDefinition`, `BackgroundDefinition`, `BackgroundDefs`, `QueueJobKeys`, and a builder with `job()`, `cron()`, and `define()`.

- [ ] **Step 1: Write failing declaration and type-inference tests**

Add these cases to `jobs/define.test.ts`:

```ts
test('j.job and j.cron produce discriminated definitions', () => {
  const j = createJobsBuilder<Record<string, never>>()
  const defs = j.define({
    email: j.job({
      input: z.object({ to: z.string() }),
      handler: async () => {},
    }),
    hourly: j.cron({
      schedule: '0 * * * *',
      handler: async () => {},
    }),
  })

  expect(defs.email.kind).toBe('job')
  expect(defs.hourly.kind).toBe('cron')
  expect(defs.hourly.schedule).toBe('0 * * * *')
})

test('cron rejects invalid expressions', () => {
  const j = createJobsBuilder<Record<string, never>>()
  expect(() =>
    j.cron({ schedule: 'not cron', handler: async () => {} }),
  ).toThrow(/invalid cron/)
})
```

Add compile-time assertions to `infer-client.test.ts` inside an existing app test:

```ts
// @ts-expect-error cron declarations cannot be enqueued
const _cronEnqueue = () => app.jobs.enqueue('hourly')
// @ts-expect-error cron declarations cannot declare input
const _cronInput = j.cron({
  schedule: '* * * * *',
  input: z.string(),
  handler: async () => {},
})
void _cronEnqueue
void _cronInput
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `bun test packages/bunderstack/src/jobs/define.test.ts packages/bunderstack/src/infer-client.test.ts`

Expected: failure because `j.cron`, discriminants, and cron filtering do not exist.

- [ ] **Step 3: Introduce the discriminated definitions**

Replace the definition model in `jobs/define.ts` with these public shapes while retaining the existing retry/backoff helpers:

```ts
export type QueueJobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  kind: 'job'
  input?: ZodType<TInput>
  retries?: number
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  concurrency?: number
  timeout?: number
  handler: (
    input: TInput,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
  onFailed?: (
    input: TInput,
    error: Error,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
}

export type CronInvocation = { scheduledFor: Date }

export type CronDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  kind: 'cron'
  schedule: string
  handler: (
    invocation: CronInvocation,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
}

export type BackgroundDefinition =
  | QueueJobDefinition<any, any, any>
  | CronDefinition<any, any>

export type BackgroundDefs = Record<string, BackgroundDefinition>

export type QueueJobKeys<TDefs extends BackgroundDefs> = {
  [K in keyof TDefs & string]: TDefs[K] extends QueueJobDefinition<any, any, any>
    ? K
    : never
}[keyof TDefs & string]
```

Make the builder attach discriminants rather than requiring callers to write them:

```ts
job<TInput = undefined>(
  def: Omit<QueueJobDefinition<TInput, TSchema, TEnvResult>, 'kind'>,
): QueueJobDefinition<TInput, TSchema, TEnvResult> {
  return { kind: 'job', ...def }
},
cron(
  def: Omit<CronDefinition<TSchema, TEnvResult>, 'kind'>,
): CronDefinition<TSchema, TEnvResult> {
  parseCron(def.schedule)
  return { kind: 'cron', ...def }
},
define<TDefs extends BackgroundDefs>(defs: TDefs): TDefs {
  validateBackgroundDefs(defs)
  return defs
},
```

Change `JobsFacade.enqueue` to accept `K extends QueueJobKeys<TDefs>`. Export the new names from `jobs/index.ts` and from the package root. Remove the old `cron?: string` property and the old cron-specific validation branches.

- [ ] **Step 4: Update queue runtime guards**

In `enqueueJob`, reject non-job definitions before parsing input:

```ts
const def = defs[name]
if (!def || def.kind !== 'job') {
  throw new Error(`[bunderstack] unknown queue job "${name}"`)
}
```

- [ ] **Step 5: Verify declarations and types**

Run: `bun test packages/bunderstack/src/jobs/define.test.ts packages/bunderstack/src/jobs/queue.test.ts packages/bunderstack/src/infer-client.test.ts`

Expected: all tests pass.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/jobs packages/bunderstack/src/infer-client.test.ts packages/bunderstack/src/index.ts
git commit -m "feat(jobs)!: separate queue jobs from cron declarations"
```

### Task 3: Make the queue runner queue-only

**Files:**
- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Modify: `packages/bunderstack/src/jobs/worker.test.ts`
- Modify: `packages/bunderstack/src/jobs/jobs.pg.test.ts`

**Interfaces:**
- Consumes: `BackgroundDefs`, `QueueJobDefinition`, and `enqueueJob()`.
- Produces: `createJobRunner()` that never parses schedules or creates cron queue rows.

- [ ] **Step 1: Replace the old cron enqueue test**

Delete the test named `cron enqueues one slot per minute, dedupe collapses repeat ticks`. Add:

```ts
test('queue runner ignores cron definitions', async () => {
  let cronRuns = 0
  const defs: BackgroundDefs = {
    scheduled: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: async () => {
        cronRuns++
      },
    },
  }
  const r = runner(defs)
  await r.tick(Date.now())
  expect(cronRuns).toBe(0)
  expect(await db.select().from(bunderstackJobs)).toEqual([])
})
```

- [ ] **Step 2: Verify the replacement test fails**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts`

Expected: failure because the current runner schedules cron rows.

- [ ] **Step 3: Remove scheduling from the queue runner**

Remove `ParsedCron`, `cronMatches`, `parseCron`, `enqueueJob`, the `crons` map,
and `scheduleCronSlots()`. Filter definitions in `runClaimable()`:

```ts
for (const [type, candidate] of Object.entries(defs)) {
  if (candidate.kind !== 'job') continue
  const def = candidate
  // existing capacity, claim, and run logic
}
```

Make `terminalPatch()` always return `{ dedupeKey: null }`, because cron slot
records no longer live in the job table. Keep tick order as lease recovery,
successful-row reaping, then claimable work.

- [ ] **Step 4: Update fixtures with explicit job discriminants**

Add `kind: 'job'` to direct `BackgroundDefs` fixtures in worker and Postgres
tests. Builder-based tests require no fixture changes.

- [ ] **Step 5: Verify queue behavior in both dialects**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/jobs.pg.test.ts`

Expected: all tests pass; no cron rows are produced.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/jobs.pg.test.ts
git commit -m "refactor(jobs): make worker consume queue jobs only"
```

### Task 4: Add leased cron-run persistence

**Files:**
- Modify: `packages/bunderstack/src/internal-tables.ts`
- Modify: `packages/bunderstack/src/internal-tables-pg.ts`
- Modify: `packages/bunderstack/src/internal-tables.test.ts`
- Create: `packages/bunderstack/src/jobs/cron-runner.ts`
- Create: `packages/bunderstack/src/jobs/cron-runner.test.ts`
- Create: `packages/bunderstack/src/jobs/cron-runner.pg.test.ts`
- Modify: `packages/bunderstack/src/jobs/index.ts`

**Interfaces:**
- Consumes: `BackgroundDefs`, `AnyDb`, `JobContext`, and the existing cron parser.
- Produces: generic `runScheduledSlot()` leasing plus the user-facing
  `runCronSlot(deps, name, slot): Promise<CronRunResult>` wrapper.

- [ ] **Step 1: Write SQLite cron-runner tests**

Cover success, duplicate success, concurrent running, failed retry, expired
lease retry, unknown name, queue-job rejection, and schedule mismatch. Use this
public result union:

```ts
export type CronRunResult =
  | { status: 'succeeded' }
  | { status: 'duplicate' }
  | { status: 'running' }
```

The central success test is:

```ts
test('runs one matching cron slot and records success', async () => {
  const seen: Date[] = []
  const slot = Date.UTC(2026, 6, 18, 12, 0)
  const result = await runCronSlot({
    db,
    defs: {
      hourly: {
        kind: 'cron',
        schedule: '0 * * * *',
        handler: async ({ scheduledFor }) => seen.push(scheduledFor),
      },
    },
    ctx: {},
    name: 'hourly',
    slot,
    now: slot,
  })
  expect(result).toEqual({ status: 'succeeded' })
  expect(seen).toEqual([new Date(slot)])
})
```

- [ ] **Step 2: Run the new test and verify failure**

Run: `bun test packages/bunderstack/src/jobs/cron-runner.test.ts`

Expected: failure because the cron-run table and runner do not exist.

- [ ] **Step 3: Add dialect-twin tables**

Add `_bunderstack_cron_runs` to both internal-table modules. The SQLite columns
are:

```ts
{
  taskId: text('task_id').notNull(),
  scheduledAt: integer('scheduled_at', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lockedUntil: integer('locked_until', { mode: 'number' }),
  lastError: text('last_error'),
  startedAt: integer('started_at', { mode: 'number' }),
  finishedAt: integer('finished_at', { mode: 'number' }),
}
```

The Postgres twin has the same keys and SQL names. Define `scheduledAt` with
`bigint('scheduled_at', { mode: 'number' })`, `lockedUntil` with
`bigint('locked_until', { mode: 'number' })`, `startedAt` with
`bigint('started_at', { mode: 'number' })`, `finishedAt` with
`bigint('finished_at', { mode: 'number' })`, and attempts with
`integer('attempts')`. Use primary key `(taskId, scheduledAt)` and index
`(status, lockedUntil)`. Register
both twins in `INTERNAL_TABLES`, `INTERNAL_TABLES_PG`,
`INTERNAL_TABLE_NAMES`, candidate identity validation, and add:

```ts
export function cronRunsTableFor(db: unknown) {
  return is(db, PgDatabase) ? bunderstackCronRunsPg : bunderstackCronRuns
}
```

- [ ] **Step 4: Implement leased slot claiming**

Implement `runScheduledSlot({ db, taskId, schedule, slot, now, run })` with this
sequence:

1. Require `slot % 60_000 === 0` and `cronMatches(parseCron(schedule), slot)`.
2. Insert a `running` row with a 60-second lease and `attempts: 1` using
   `onConflictDoNothing()`.
3. If the insert loses, return `duplicate` for `succeeded`, `running` for an
   unexpired lease, or atomically update `failed`/expired rows to a new lease
   while incrementing attempts.
4. Invoke `run(new Date(slot))`.
5. Mark success with `finishedAt`; on error mark `failed`, store the message,
   clear the lease, and rethrow.

The reclaim update must include the prior status/lease predicate in its SQL
`WHERE`; checking in memory alone is insufficient.

Implement `runCronSlot()` as a narrow wrapper: require a declared
`kind: 'cron'`, prefix the declared name with `cron:` for its task ID, pass that
ID and the definition's schedule into `runScheduledSlot()`, and invoke the typed
handler with the application context.

- [ ] **Step 5: Add the Postgres parity test**

Provision the merged PG schema in memory, run one slot twice, and assert first
`succeeded`, second `duplicate`, and one persisted row.

- [ ] **Step 6: Verify persistence and dialect parity**

Run: `bun test packages/bunderstack/src/internal-tables.test.ts packages/bunderstack/src/jobs/cron-runner.test.ts packages/bunderstack/src/jobs/cron-runner.pg.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/internal-tables.ts packages/bunderstack/src/internal-tables-pg.ts packages/bunderstack/src/internal-tables.test.ts packages/bunderstack/src/jobs
git commit -m "feat(cron): persist leased schedule slots"
```

### Task 5: Add the signed cron HTTP endpoint

**Files:**
- Create: `packages/bunderstack/src/jobs/cron-auth.ts`
- Create: `packages/bunderstack/src/jobs/cron-auth.test.ts`
- Create: `packages/bunderstack/src/jobs/cron-router.ts`
- Create: `packages/bunderstack/src/jobs/cron-router.test.ts`
- Create: `packages/bunderstack/src/cron.ts`
- Modify: `packages/bunderstack/src/env.ts`
- Modify: `packages/bunderstack/src/env.test.ts`
- Modify: `packages/bunderstack/src/handler.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/package.json`

**Interfaces:**
- Consumes: `runCronSlot`, `BackgroundDefs`, validated environment, and Hono.
- Produces: `signScheduleRequest(secret, taskId, slot)`, public
  `bunderstack/cron` helpers, and mounted cron and maintenance endpoints.

- [ ] **Step 1: Write signature tests**

Use a deterministic HMAC test:

```ts
test('signs and verifies the canonical task identifier and slot', async () => {
  const signature = await signScheduleRequest(
    'secret',
    'cron:hourly',
    1_721_307_600_000,
  )
  expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
  expect(
    await verifyScheduleRequest(
      'secret',
      'cron:hourly',
      1_721_307_600_000,
      signature,
    ),
  ).toBe(true)
  expect(
    await verifyScheduleRequest(
      'secret',
      'maintenance:hourly',
      1_721_307_600_000,
      signature,
    ),
  ).toBe(false)
})
```

- [ ] **Step 2: Write router status tests**

Test missing/invalid signature `401`, unknown task `404`, malformed, stale,
future, or nonmatching slots `400`, concurrent lease `202`, success and
duplicate `200`, and thrown handler `500`. Cover both `cron/:name` and
`maintenance/storage-sweep`; assert that maintenance calls `storage.sweep()`
and uses the same persisted slot lease.

- [ ] **Step 3: Verify the new tests fail**

Run: `bun test packages/bunderstack/src/jobs/cron-auth.test.ts packages/bunderstack/src/jobs/cron-router.test.ts`

Expected: failure because auth and router modules do not exist.

- [ ] **Step 4: Implement canonical HMAC authentication**

Use `createHmac('sha256', secret).update(`${taskId}\n${slot}`).digest('hex')`
and `timingSafeEqual` over equal-length byte arrays. Expose signatures in
`sha256=<hex>` form. Reject malformed encodings before comparing.

Re-export `parseCron`, `cronMatches`, `signScheduleRequest`, and
`verifyScheduleRequest` from `src/cron.ts`, and add the package export
`"./cron": "./src/cron.ts"`. This is the only background protocol surface
Bunderhost imports.

- [ ] **Step 5: Extend validated environment**

Add optional `BUNDERSTACK_CRON_SECRET` to `BaseEnv` and populate it from the
source. Resolve the background declarations before environment validation,
compute whether user cron or platform maintenance is configured, and pass that
boolean into `validateEnv`. In production add an aggregated validation issue
when signed scheduled work exists without the secret. Keep
`BUNDERSTACK_INTROSPECT=1` lenient.

- [ ] **Step 6: Build and mount the router**

Create `buildCronRouter({ db, defs, ctx, secret, storage })`. Read the two
headers and verify `cron:<name>` or `maintenance:<name>`. User cron calls
`runCronSlot`; `maintenance/storage-sweep` calls `runScheduledSlot()` with task
ID `maintenance:storage-sweep`, its manifest schedule, and `storage.sweep()` as
the callback. Reject slots older than 60 minutes or more than one minute in the
future before claiming them. After a successful storage sweep, delete completed
schedule-run rows older than 30 days. Map the result union to the specified HTTP
status.
Add `cronRouter?: Hono` to `HandlerParts` and mount it before the generic CRUD
router at `/api/_bunderstack` so a user table cannot shadow it.

- [ ] **Step 7: Verify HTTP behavior**

Run: `bun test packages/bunderstack/src/jobs/cron-auth.test.ts packages/bunderstack/src/jobs/cron-router.test.ts packages/bunderstack/src/env.test.ts`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/bunderstack/package.json packages/bunderstack/src/cron.ts packages/bunderstack/src/jobs packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts packages/bunderstack/src/handler.ts packages/bunderstack/src/index.ts
git commit -m "feat(cron): expose signed schedule delivery endpoint"
```

### Task 6: Introduce explicit lifecycle and worker handles

**Files:**
- Create: `packages/bunderstack/src/lifecycle.ts`
- Create: `packages/bunderstack/src/lifecycle.test.ts`
- Create: `packages/bunderstack/src/jobs/runtime.ts`
- Create: `packages/bunderstack/src/jobs/runtime.test.ts`
- Modify: `packages/bunderstack/src/jobs/define.ts`
- Modify: `packages/bunderstack/src/jobs/index.ts`

**Interfaces:**
- Consumes: queue-only `createJobRunner()` and the application cleanup signal.
- Produces: `Lifecycle`, `WorkerHandle`, `startJobWorker()`, and blocking signal-aware `runJobWorker()`.

- [ ] **Step 1: Write lifecycle tests**

Cover reverse-order cleanup, idempotent close, concurrent close returning the
same promise, aggregated cleanup errors, and refusal to register resources after
closing. Assert status transitions `ready -> closing -> closed`.

- [ ] **Step 2: Write worker-loop tests**

Use an injected `tick` and short poll interval to prove:

```ts
test('poll loop never overlaps ticks and closes gracefully', async () => {
  let active = 0
  let maxActive = 0
  const handle = startJobWorker({
    pollIntervalMs: 1,
    tick: async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 15))
  await handle.close()
  expect(maxActive).toBe(1)
})
```

Also assert that aborting a supplied signal closes the handle and that
`runJobWorker()` removes every signal listener it installs.

- [ ] **Step 3: Verify tests fail**

Run: `bun test packages/bunderstack/src/lifecycle.test.ts packages/bunderstack/src/jobs/runtime.test.ts`

Expected: failure because lifecycle and runtime modules do not exist.

- [ ] **Step 4: Implement the lifecycle registry**

Expose:

```ts
export type Cleanup = () => void | Promise<void>

export class Lifecycle {
  readonly signal: AbortSignal
  get status(): 'ready' | 'closing' | 'closed'
  add(cleanup: Cleanup): () => void
  close(): Promise<void>
}
```

`close()` aborts first, executes still-registered cleanups in reverse order,
uses `Promise.allSettled` semantics, and throws one `AggregateError` after all
cleanups have run.

- [ ] **Step 5: Implement the non-overlapping worker loop**

Expose:

```ts
export type WorkerHandle = {
  readonly closed: Promise<void>
  close(): Promise<void>
}

export type StartWorkerOptions = {
  signal?: AbortSignal
  pollIntervalMs?: number
}

export type RunWorkerOptions = StartWorkerOptions
```

Use an async `while (!signal.aborted)` loop and an abortable timer between
ticks; do not use `setInterval`. Combine the caller signal, application signal,
and private handle controller so any one stops the loop. `close()` aborts the
private controller and awaits the loop. A failed tick is reported through an
injected `onError` callback and polling continues.

- [ ] **Step 6: Verify lifecycle and loop semantics**

Run: `bun test packages/bunderstack/src/lifecycle.test.ts packages/bunderstack/src/jobs/runtime.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/lifecycle.ts packages/bunderstack/src/lifecycle.test.ts packages/bunderstack/src/jobs
git commit -m "feat(runtime): add explicit worker lifecycle"
```

### Task 7: Make `createBunderstack()` construction-only

**Files:**
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`
- Modify: `packages/bunderstack/src/crud-broadcast.test.ts`
- Modify: `packages/bunderstack/src/realtime/index.ts`
- Modify: `packages/bunderstack/src/realtime/redis.ts`
- Modify: `packages/bunderstack/src/realtime/redis.test.ts`
- Create: `packages/bunderstack/src/app-lifecycle.test.ts`

**Interfaces:**
- Consumes: `Lifecycle`, queue runner, worker runtime, cron router, storage facade, and realtime brokers.
- Produces: public `app.startWorker()`, `app.runWorker()`, `app.close()`, `app.status`, and `app.signal`.

- [ ] **Step 1: Write integration tests for zero implicit execution**

Replace the existing polling race in `jobs/integration.test.ts` with:

```ts
await app.jobs.enqueue('writeNote', { id: 'n1', body: 'queued' })
await new Promise((resolve) => setTimeout(resolve, 20))
expect(await app.db.select().from(notes)).toEqual([])

const worker = await app.startWorker({ pollIntervalMs: 1 })
await worker.close()
expect((await app.db.select().from(notes))[0]?.body).toBe('queued')
```

Add tests proving construction does not call storage sweep, job tick, or Redis
subscribe; two `app.close()` calls succeed; and `startWorker()` after close
rejects. Add focused `runWorker()` tests proving an injected signal closes the
whole application without installing process listeners, while an omitted signal
installs and subsequently removes one `SIGINT` and one `SIGTERM` listener.

- [ ] **Step 2: Verify the tests fail against implicit timers**

Run: `bun test packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/app-lifecycle.test.ts`

Expected: failure because enqueue wakes the current runner and application
lifecycle methods do not exist.

- [ ] **Step 3: Remove implicit background work from the composition root**

Delete `SWEEP_INTERVAL_MS`, `JOBS_POLL_INTERVAL_MS`, both `setInterval` blocks,
and wake-on-enqueue. Keep `app.jobs.tick()` as an explicit deterministic test
and maintenance escape hatch.

Create one `Lifecycle` during app construction. Implement:

```ts
startWorker: async (options = {}) => {
  if (!jobRunner) throw new Error('[bunderstack] no queue jobs configured')
  const handle = startJobWorker({
    ...options,
    tick: (now) => jobRunner.tick(now),
  })
  const unregister = lifecycle.add(() => handle.close())
  handle.closed.finally(unregister)
  return handle
},
runWorker: async (options = {}) => {
  const handle = await app.startWorker(options)
  try {
    await runUntilSignal(handle, options.signal)
  } finally {
    await app.close()
  }
},
close: () => lifecycle.close(),
get status() {
  return lifecycle.status
},
signal: lifecycle.signal,
```

When `options.signal` is omitted, `runUntilSignal` installs `SIGINT` and
`SIGTERM` listeners and removes both on exit. When supplied, it installs no
process listeners. The worker loop performs its first tick immediately and
never overlaps ticks. The final implementation must avoid referring to `app`
before initialization; define closures before the object literal and attach
them in the literal.

- [ ] **Step 4: Make Redis subscription lazy and closeable**

Extend `RealtimeBroker` with `start(): Promise<void>` and `close(): Promise<void>`.
Memory broker methods are no-ops. Redis broker creates command/subscriber clients
inside `start()`, subscribes once, and closes both inside `close()`. The SSE GET
route awaits `broker.start()` before registering its first subscriber. Register
`broker.close()` with the app lifecycle without starting it.

- [ ] **Step 5: Verify app, jobs, storage, and realtime behavior**

Run: `bun test packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/app-lifecycle.test.ts packages/bunderstack/src/realtime packages/bunderstack/src/storage/lifecycle.test.ts`

Expected: all tests pass and no test relies on an implicit timer.

- [ ] **Step 6: Verify all package types**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src
git commit -m "feat(app)!: make background runtime explicit"
```

### Task 8: Add manifest v2 and the local cron scheduler

**Files:**
- Modify: `packages/bunderstack/src/manifest.ts`
- Modify: `packages/bunderstack/src/manifest.test.ts`
- Create: `packages/bunderstack/src/jobs/local-cron.ts`
- Create: `packages/bunderstack/src/jobs/local-cron.test.ts`
- Modify: `packages/bunderstack/src/index.ts`

**Interfaces:**
- Consumes: discriminated definitions, `runCronSlot()`, lifecycle registry, storage config.
- Produces: manifest v2 and `app.startCronScheduler()` for standalone development.

- [ ] **Step 1: Replace manifest expectations**

Assert this exact background structure:

```ts
expect(manifest).toMatchObject({
  version: 2,
  background: {
    jobs: [{ name: 'generateLook' }],
    cron: [{ name: 'nightly', schedule: '0 3 * * *', timezone: 'UTC' }],
    maintenance: [
      { name: 'storage-sweep', schedule: '0 4 * * *' },
    ],
  },
})
```

- [ ] **Step 2: Write deterministic local scheduler tests**

Inject `now`, `setTimer`, and `runSlot` dependencies. Assert that the scheduler
rounds to UTC minutes, executes each matching user cron once, triggers storage
sweep at its declared schedule, and stops on close without leaving a timer.

- [ ] **Step 3: Verify tests fail**

Run: `bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/jobs/local-cron.test.ts`

Expected: failure because manifest v2 and local scheduler do not exist.

- [ ] **Step 4: Build manifest v2**

Replace `jobs: ManifestJob[]` with:

```ts
export type BunderstackManifest = {
  version: 2
  dialect: Dialect
  tables: string[]
  defaultBucket: string
  buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  realtime: boolean
  env: { server: ManifestEnvVar[]; client: ManifestEnvVar[] }
  background: {
    jobs: { name: string }[]
    cron: { name: string; schedule: string; timezone: 'UTC' }[]
    maintenance: { name: 'storage-sweep'; schedule: string }[]
  }
}
```

Partition definitions by `kind`. Include daily storage sweep only when storage
has at least one resolved bucket. Export the new manifest member types.

- [ ] **Step 5: Implement local scheduling**

`startLocalCronScheduler()` uses one rescheduled timeout rather than an interval,
calls `runCronSlot()` for user definitions, calls `storage.sweep()` for the
built-in maintenance entry, reports errors through `onError`, and returns a
closeable handle. Attach it to `app.startCronScheduler()` and the app lifecycle.

- [ ] **Step 6: Verify manifest and local execution**

Run: `bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/jobs/local-cron.test.ts packages/bunderstack/src/app-lifecycle.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/bunderstack/src/manifest.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/jobs packages/bunderstack/src/index.ts
git commit -m "feat(manifest)!: describe explicit background roles"
```

### Task 9: Migrate examples and documentation

**Files:**
- Modify: `examples/todo/src/bunderstack.ts`
- Create: `examples/todo/src/worker.ts`
- Modify: `examples/todo/README.md`
- Modify: `README.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `website/content/docs/configuration.mdx`
- Modify: `website/content/docs/storage.mdx`
- Create: `website/content/docs/background-jobs.mdx`
- Modify: `website/content/docs/meta.json`

**Interfaces:**
- Consumes: final public worker, cron, handler, and lifecycle APIs.
- Produces: copy-pasteable TanStack Start, standalone Bun, local worker, and Bunderhost examples.

- [ ] **Step 1: Convert the todo declarations**

Keep `celebrateBoardComplete` as `j.job()`. Convert `archiveDoneTodos` to:

```ts
archiveDoneTodos: j.cron({
  schedule: '* * * * *',
  handler: async ({ scheduledFor }, ctx) => {
    const cutoff = new Date(
      scheduledFor.getTime() - ARCHIVE_DONE_TODOS_AFTER_MS,
    )
    await ctx.db
      .delete(schema.todos)
      .where(and(eq(schema.todos.done, true), lt(schema.todos.completedAt, cutoff)))
  },
}),
```

- [ ] **Step 2: Add the explicit local worker entry**

Create `examples/todo/src/worker.ts`:

```ts
import { app } from './bunderstack'

await app.runWorker()
```

Add a package script `worker: "bun src/worker.ts"`. Document running app,
worker, and local cron scheduler separately.

- [ ] **Step 3: Rewrite background documentation**

Document the deployment consequence explicitly:

- queue job declared -> Bunderhost provisions an always-on worker Machine;
- cron declared -> Bunderhost wakes the scale-to-zero web Machine by signed HTTP;
- preview background execution is disabled by default;
- long cron work should enqueue a job;
- handlers must be idempotent.

Remove every stale `storageOptions` example and use per-bucket `storage.buckets`
configuration. Correct every missing `await createBunderstack()` call.

- [ ] **Step 4: Verify examples and docs source**

Run: `bun test`

Expected: all tests pass except the existing real-Postgres conditional skip.

Run: `bun run typecheck`

Expected: exit 0.

Run: `bun run --cwd website build`

Expected: exit 0 and documentation routes build successfully.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/bunderstack/README.md examples/todo website/content/docs
git commit -m "docs: explain workers cron and application lifecycle"
```

### Task 10: Final library verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: evidence that the library half of manifest v2 is ready for Bunderhost integration.

- [ ] **Step 1: Run formatting and lint checks**

Run: `bun run format`

Expected: exit 0.

Run: `bun run lint`

Expected: exit 0.

- [ ] **Step 2: Run static checking**

Run: `bun run typecheck`

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Run the full suite**

Run: `bun test`

Expected: zero failures; only the credential-gated real-Postgres test may skip.

- [ ] **Step 4: Inspect the published manifest shape**

Run:

```bash
BUNDERSTACK_INTROSPECT=1 bun -e "const { app } = await import('./examples/todo/src/bunderstack.ts'); console.log(JSON.stringify(app.manifest, null, 2))"
```

Expected: `version: 2`, one queue job, one cron declaration, UTC timezone, and
the storage maintenance schedule.

- [ ] **Step 5: Commit formatting-only changes if produced**

Run `git status --short` and `git diff --name-only`. If formatting changed
tracked files, stage each reported path explicitly only after confirming it was
already modified by Tasks 1–9, then commit with
`chore: finalize background runtime`. Never use `git add .`; skip this commit
when formatting produced no tracked changes.
