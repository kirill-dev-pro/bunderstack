# Continuous Job Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Bunderstack worker honor job concurrency above ten and refill each freed execution slot immediately instead of waiting for an entire claimed wave.

**Architecture:** Keep deterministic `jobs.tick()` as a complete, awaited wave for tests, but teach it to fill the declared capacity through repeated bounded claims. Add a production pump with a process-local active-task registry; the generic worker loop waits for either the first task completion or its polling interval, pumps again without overlap, and drains active work during shutdown.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, libSQL/SQLite and PostgreSQL queue adapters, Bunderstack lifecycle and testing fixtures.

**Spec:** `docs/superpowers/specs/2026-08-31-continuous-job-worker-design.md`

## Global Constraints

- Preserve `_bunderstack_jobs`, migrations, retry, backoff, dedupe, cron, retention, and at-least-once delivery semantics.
- Keep the internal SQL claim batch at exactly `10`; it is a statement-size bound, not an execution ceiling.
- An omitted queue-job `concurrency` retains an effective per-type capacity of `10` in one worker process.
- `jobs.tick()` remains deterministic, awaits its complete claimed wave, and leaves work enqueued by handlers for a later tick.
- `startWorker()` and `runWorker()` use continuous refill in both `BUNDERSTACK_ROLE=all` and `BUNDERSTACK_ROLE=worker` topologies.
- `WorkerHandle.close()` stops new claims and waits for active work, matching the current graceful-close behavior.
- Do not add worker pools, autoscaling, worker registration, lease renewal, provider rate limiting, or strict global concurrency across processes.
- Keep low-level `startJobWorker()` source-compatible with callbacks returning `Promise<void>`.
- Use Bun commands and introduce each production behavior through a failing test before implementation.
- Run `bun run verify:consumer` because exported worker option types change additively.

---

### Task 1: Fill deterministic concurrency through bounded claim batches

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts:23,212-249,329-368`
- Modify: `packages/bunderstack/src/jobs/worker.test.ts:202-225`

**Interfaces:**

- Produces: private `type ClaimedWork = { row: JobRow; def: AnyBackgroundDefinition; leaseUntil: number }`.
- Produces: private `capacityFor(def: AnyBackgroundDefinition): number`, returning a queue job's declared concurrency or `10`.
- Produces: private `claimAvailable(type, def, now): Promise<ClaimedWork[]>`, repeatedly claiming batches of at most ten until observed free capacity or runnable work is exhausted.
- Preserves: `createJobRunner(...).tick(now?): Promise<TickResult>` and its complete-wave semantics.

- [ ] **Step 1: Replace the concurrency-one regression with a gate-controlled concurrency-25 test**

Keep the existing concurrency-one assertion, then add a separate test after it. Enqueue 26 rows, block every handler on one shared gate, and resolve `allStarted` when the 25th handler begins:

```ts
test('tick fills declared concurrency above the internal claim batch', async () => {
  let started = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let resolveAllStarted: (() => void) | undefined
  const allStarted = new Promise<void>((resolve) => {
    resolveAllStarted = resolve
  })
  const defs: JobsDefs = {
    wide: {
      kind: 'job',
      concurrency: 25,
      handler: async () => {
        started++
        if (started === 25) resolveAllStarted?.()
        await gate
      },
    },
  }
  const r = runner(defs)
  for (let i = 0; i < 26; i++) {
    await enqueueJob(db, defs, 'wide', undefined)
  }

  const ticking = r.tick()
  await allStarted
  expect(started).toBe(25)
  expect(
    (await db.select().from(bunderstackJobs)).filter(
      (row) => row.status === 'running',
    ),
  ).toHaveLength(25)

  release?.()
  expect(await ticking).toEqual({ claimed: 25, ran: 25, failed: 0 })
  expect(
    (await db.select().from(bunderstackJobs)).filter(
      (row) => row.status === 'pending',
    ),
  ).toHaveLength(1)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test packages/bunderstack/src/jobs/worker.test.ts --timeout 10000
```

Expected: the new test times out waiting for 25 starts because one tick claims only `CLAIM_BATCH = 10`.

- [ ] **Step 3: Extract capacity and repeated-claim helpers**

In `createJobRunner`, define the work item and capacity rule:

```ts
type ClaimedWork = {
  row: JobRow
  def: AnyBackgroundDefinition
  leaseUntil: number
}

function capacityFor(def: AnyBackgroundDefinition): number {
  return def.kind === 'job' && def.concurrency !== undefined
    ? def.concurrency
    : CLAIM_BATCH
}
```

Replace the one-shot claim code with a helper that preserves the current
database-observed capacity calculation, then fills that capacity in bounded
statements:

```ts
async function claimAvailable(
  type: string,
  def: AnyBackgroundDefinition,
  now: number,
): Promise<ClaimedWork[]> {
  const runningRows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.type, type), eq(t.status, 'running')))
  let available = capacityFor(def) - runningRows.length
  if (available <= 0) return []

  const leaseUntil = now + (def.timeout ?? DEFAULT_TIMEOUT_MS)
  const work: ClaimedWork[] = []
  while (available > 0) {
    const limit = Math.min(CLAIM_BATCH, available)
    const rows = await claim(type, limit, now, leaseUntil)
    for (const row of rows) work.push({ row, def, leaseUntil })
    available -= rows.length
    if (rows.length < limit) break
  }
  return work
}
```

Update `runClaimable()` to call `claimAvailable(type, def, now)` for every
definition before starting any handler. Keep the existing `Promise.all`, result
counting, and rule that handler-enqueued work belongs to the next tick.

- [ ] **Step 4: Run worker tests and verify GREEN**

Run:

```bash
bun test packages/bunderstack/src/jobs/worker.test.ts
```

Expected: all worker tests PASS; the new report is exactly `{ claimed: 25, ran: 25, failed: 0 }` and one row remains pending.

- [ ] **Step 5: Commit the complete-wave improvement**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "fix(jobs): honor concurrency above claim batch"
```

### Task 2: Add the continuous production pump and active-task registry

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Modify: `packages/bunderstack/src/jobs/worker.test.ts`

**Interfaces:**

- Consumes: `ClaimedWork`, `claimAvailable(type, def, now)`, and the existing `runJob(row, def, now, leaseUntil)` from Task 1.
- Produces: private `type PumpResult = { wake?: Promise<void> }` and `createJobRunner(...).pump(now?): Promise<PumpResult>`; do not re-export the type from `jobs/index.ts`.
- Produces: `createJobRunner(...).drain(): Promise<void>`.
- Preserves: `createJobRunner(...).tick()` for deterministic callers.

- [ ] **Step 1: Write a failing no-wave-barrier test**

Add a helper that waits for a condition without fixed long sleeps:

```ts
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}
```

Then add a production-pump test with three controlled handlers and concurrency two:

```ts
test('pump refills a freed slot while another handler remains active', async () => {
  const started: number[] = []
  const releases = new Map<number, () => void>()
  let next = 0
  const defs: JobsDefs = {
    continuous: {
      kind: 'job',
      input: v.object({ n: v.number() }),
      concurrency: 2,
      handler: async ({ n }) => {
        started.push(n)
        await new Promise<void>((resolve) => releases.set(n, resolve))
      },
    },
  }
  const r = runner(defs)
  for (let n = 1; n <= 3; n++) {
    await enqueueJob(db, defs, 'continuous', { n }, { runAt: ++next })
  }

  const first = await r.pump(10)
  await waitFor(() => started.length === 2)
  expect(started).toEqual([1, 2])
  expect(first.wake).toBeDefined()

  releases.get(1)?.()
  await first.wake
  await r.pump(10)
  await waitFor(() => started.length === 3)
  expect(started).toEqual([1, 2, 3])

  releases.get(2)?.()
  releases.get(3)?.()
  await r.drain()
})
```

Do not release handler 2 before handler 3 starts; that assertion is what proves the old `Promise.all` wave barrier is gone.

- [ ] **Step 2: Run the new pump test and verify RED**

Run:

```bash
bun test packages/bunderstack/src/jobs/worker.test.ts --timeout 10000
```

Expected: FAIL with `r.pump is not a function`.

- [ ] **Step 3: Factor shared maintenance out of deterministic tick**

Extract the pre-claim work without changing its order:

```ts
async function maintain(now: number) {
  await materializeCronSlots(now)
  await recoverExpiredLeases(now)
  if (now - lastReapAt >= REAP_INTERVAL_MS) {
    lastReapAt = now
    await reapSucceeded(now)
  }
}
```

Make `tick(now)` call `maintain(now)` followed by the existing awaited `runClaimable(now)`.

- [ ] **Step 4: Implement process-local active execution**

Add a registry beside `lastReapAt`:

```ts
const active = new Map<string, Set<Promise<void>>>()
```

Add helpers that start a claimed row, always remove it from the registry, and log unexpected infrastructure errors instead of creating an unhandled rejection:

```ts
function startWork(
  type: string,
  work: ClaimedWork,
  claimedAt: number,
): Promise<void> {
  let tasks = active.get(type)
  if (!tasks) {
    tasks = new Set()
    active.set(type, tasks)
  }
  let task: Promise<void>
  task = runJob(work.row, work.def, claimedAt, work.leaseUntil)
    .then(() => undefined)
    .catch((error) => {
      logger.error('[bunderstack] background job execution failed:', error)
    })
    .finally(() => {
      tasks!.delete(task)
      if (tasks!.size === 0) active.delete(type)
    })
  tasks.add(task)
  return task
}
```

Retry `runAt` calculations therefore continue to use the pump's claim clock as
they do in deterministic ticks.

Define the private result and implement `pump()` and `drain()`:

```ts
type PumpResult = { wake?: Promise<void> }

async function pump(now: number = Date.now()): Promise<PumpResult> {
  await maintain(now)
  for (const [name, def] of Object.entries(defs)) {
    const type = def.kind === 'cron' ? `${CRON_PREFIX}${name}` : name
    const work = await claimAvailable(type, def, now)
    for (const item of work) startWork(type, item, now)
  }
  const snapshot = [...active.values()].flatMap((tasks) => [...tasks])
  return snapshot.length === 0
    ? {}
    : { wake: Promise.race(snapshot).then(() => undefined) }
}

async function drain(): Promise<void> {
  const snapshot = [...active.values()].flatMap((tasks) => [...tasks])
  await Promise.allSettled(snapshot)
}
```

Expose `pump` and `drain` on the object returned by `createJobRunner`. Do not add them to `JobsRuntimeFacade` or `app.jobs`; they are worker-runtime internals.

- [ ] **Step 5: Add and pass the above-ten pump assertion**

Add a second pump test proving production execution also fills above ten:

```ts
test('pump fills concurrency above the internal claim batch', async () => {
  let started = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let resolveAllStarted: (() => void) | undefined
  const allStarted = new Promise<void>((resolve) => {
    resolveAllStarted = resolve
  })
  const defs: JobsDefs = {
    wide: {
      kind: 'job',
      concurrency: 25,
      handler: async () => {
        started++
        if (started === 25) resolveAllStarted?.()
        await gate
      },
    },
  }
  const r = runner(defs)
  for (let i = 0; i < 26; i++) {
    await enqueueJob(db, defs, 'wide', undefined)
  }

  const cycle = await r.pump()
  await allStarted
  expect(cycle.wake).toBeDefined()
  expect(started).toBe(25)
  const rows = await db.select().from(bunderstackJobs)
  expect(rows.filter((row) => row.status === 'running')).toHaveLength(25)
  expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1)

  release?.()
  await r.drain()
})
```

Run:

```bash
bun test packages/bunderstack/src/jobs/worker.test.ts
```

Expected: all tests PASS without unhandled-rejection warnings.

- [ ] **Step 6: Commit the continuous runner primitive**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "feat(jobs): add continuous worker pump"
```

### Task 3: Wake the production loop on slot completion and drain on close

**Files:**

- Modify: `packages/bunderstack/src/jobs/runtime.ts`
- Modify: `packages/bunderstack/src/jobs/runtime.test.ts`
- Modify: `packages/bunderstack/src/jobs/index.ts`
- Modify: `packages/bunderstack/src/runtime.ts:186-198,589-612`
- Modify: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**

- Consumes: `jobRunner.pump(now): Promise<{ wake?: Promise<void> }>` and `jobRunner.drain(): Promise<void>` from Task 2.
- Produces: exported low-level `WorkerCycleResult = { wake?: Promise<void> }` in `jobs/runtime.ts`.
- Re-exports: `WorkerCycleResult` from `jobs/index.ts` beside `StartWorkerOptions` and `WorkerHandle`.
- Widens: `StartWorkerOptions.tick` to `(now: number) => Promise<void | WorkerCycleResult>`.
- Adds: internal `StartWorkerOptions.drain?: () => Promise<void>`.
- Preserves: `AppStartWorkerOptions` as `Omit<StartWorkerOptions, 'tick' | 'drain'>`, so applications cannot replace the Bunderstack drain hook.

- [ ] **Step 1: Write failing runtime wake and drain tests**

Add a deferred helper in `jobs/runtime.test.ts`:

```ts
function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}
```

Add a test proving a long polling interval does not delay refill:

```ts
test('task completion wakes the loop before the polling interval', async () => {
  const slot = deferred()
  const secondTick = deferred()
  let ticks = 0
  const handle = startJobWorker({
    pollIntervalMs: 60_000,
    tick: async () => {
      ticks++
      if (ticks === 1) return { wake: slot.promise }
      secondTick.resolve()
      return {}
    },
  })

  slot.resolve()
  await secondTick.promise
  expect(ticks).toBe(2)
  await handle.close()
})
```

Add a close test whose `drain` waits on a deferred active task. Assert `close()`
remains unsettled until the gate is released and `drain` runs exactly once:

```ts
test('close stops polling and waits for drain', async () => {
  const active = deferred()
  const enteredDrain = deferred()
  let drained = 0
  let closed = false
  const handle = startJobWorker({
    pollIntervalMs: 60_000,
    tick: async () => ({ wake: active.promise }),
    drain: async () => {
      drained++
      enteredDrain.resolve()
      await active.promise
    },
  })

  const closing = handle.close().then(() => {
    closed = true
  })
  await enteredDrain.promise
  expect(closed).toBe(false)
  expect(drained).toBe(1)

  active.resolve()
  await closing
  expect(closed).toBe(true)
  expect(drained).toBe(1)
})
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```bash
bun test packages/bunderstack/src/jobs/runtime.test.ts
```

Expected: TypeScript/runtime failure because tick results and `drain` are not supported; with the existing loop, the second tick waits for the 60-second poll.

- [ ] **Step 3: Implement wake-or-poll waiting and graceful drain**

Add the result type and widen the options:

```ts
export type WorkerCycleResult = { wake?: Promise<void> }

export type StartWorkerOptions = {
  signal?: AbortSignal
  pollIntervalMs?: number
  tick: (now: number) => Promise<void | WorkerCycleResult>
  drain?: () => Promise<void>
  onError?: (error: Error) => void
}
```

Add `WorkerCycleResult` to the type-export block in `jobs/index.ts` so the
public `StartWorkerOptions.tick` signature never names an unreachable type.

Add a single cancellable waiter. It must clear its timer when wake or abort wins,
otherwise a `pollIntervalMs: 60_000` timer would keep tests and worker shutdown
alive for the full minute:

```ts
function waitForNext(
  ms: number,
  signal: AbortSignal,
  wake: Promise<void> | undefined,
  onError: ((error: Error) => void) | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(done, ms)
    function done() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    void wake?.then(done, (error) => {
      onError?.(toError(error))
      done()
    })
    if (signal.aborted) done()
  })
}
```

After each non-overlapping tick, call
`waitForNext(pollIntervalMs, controller.signal, cycle?.wake, options.onError)`.
Keep tick failures routed to `onError` and followed by `waitForNext` without a
wake promise; do not create a tight retry loop. In the worker-loop `finally`,
remove the parent abort listener and then `await options.drain?.()`.

- [ ] **Step 4: Connect the application runtime to pump and drain**

Change the public app option alias:

```ts
export type AppStartWorkerOptions = Omit<
  StartWorkerOptions,
  'tick' | 'drain'
>
```

In `startWorker()`, replace the deterministic callback with the production methods:

```ts
const handle = startJobWorker({
  ...options,
  signal,
  tick: (now) => jobRunner.pump(now),
  drain: () => jobRunner.drain(),
})
```

Leave `app.jobs.tick()` and the captured testing handle wired to `jobRunner.tick()`.

- [ ] **Step 5: Add an application-level refill regression**

In `jobs/integration.test.ts`, add this bounded helper:

```ts
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}
```

Then add this public embedded-worker regression:

```ts
test('embedded worker refills one slot without waiting for its active peers', async () => {
  const started: number[] = []
  const releases = new Map<number, () => void>()
  const app = await bunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    background: { autoStart: false },
    jobs: (j) =>
      j.define({
        controlled: j.job({
          input: v.object({ n: v.number() }),
          concurrency: 2,
          handler: async ({ n }) => {
            started.push(n)
            await new Promise<void>((resolve) => releases.set(n, resolve))
          },
        }),
      }),
  }).start()
  await provision(app, { force: true })
  for (let n = 1; n <= 3; n++) {
    await app.jobs.enqueue('controlled', { n }, { runAt: n })
  }

  const worker = await app.startWorker({ pollIntervalMs: 60_000 })
  await waitFor(() => started.length === 2)
  expect(started).toEqual([1, 2])

  releases.get(1)?.()
  await waitFor(() => started.length === 3)
  expect(started).toEqual([1, 2, 3])

  releases.get(2)?.()
  releases.get(3)?.()
  await worker.close()
  await app.close()
})
```

Do not release job 2 before job 3 starts. The 60-second poll interval makes the
test prove a completion wakeup rather than an ordinary poll.

- [ ] **Step 6: Run lifecycle and integration tests**

Run:

```bash
bun test packages/bunderstack/src/jobs/runtime.test.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/integration.test.ts
```

Expected: all tests PASS; no test waits for the configured 60-second poll interval.

- [ ] **Step 7: Typecheck the package and commit**

Run:

```bash
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: exit 0.

Commit:

```bash
git add packages/bunderstack/src/jobs/runtime.ts packages/bunderstack/src/jobs/runtime.test.ts packages/bunderstack/src/jobs/index.ts packages/bunderstack/src/runtime.ts packages/bunderstack/src/jobs/integration.test.ts
git commit -m "feat(jobs): refill worker capacity continuously"
```

### Task 4: Document concurrency semantics and remove Agent Chat's duplicate loop

**Files:**

- Modify: `website/content/docs/background-jobs.mdx:35-78`
- Modify: `CHANGELOG.md:1-5`
- Modify: `packages/bunderstack/CHANGELOG.md:1-5`
- Modify: `examples/agent-chat/src/bunderstack.ts:95-104`
- Modify: `examples/agent-chat/README.md:10-20`

**Interfaces:**

- Documents: omitted concurrency has an effective capacity of ten for the ordinary one-worker topology.
- Documents: declared concurrency above ten is filled through bounded claim batches and continuously refilled.
- Preserves: Agent Chat's embedded `all` topology through `backend.start()` auto-start, without a second explicit `app.startWorker()`.

- [ ] **Step 1: Add the worker-pool behavior to the background jobs guide**

After the production-worker introduction, add a `### Concurrency` subsection with this content:

````md
### Concurrency

Queue jobs run in a continuous per-type pool. With one worker, omitted
`concurrency` gives that type 10 execution slots.

```ts
generateAnswer: j.job({
  concurrency: 32,
  timeout: 120_000,
  handler: async (input, ctx) => {},
})
```

The worker claims rows in internal batches of at most 10 until all 32 slots are
full. Ten is a database batch size, not a concurrency ceiling. When one handler
finishes, the worker fills that slot immediately without waiting for the other
handlers that started beside it.

Across several worker processes, the current database-observed capacity check
is best effort and can race; `concurrency` is not a strict provider-wide
semaphore. Use an application/provider limiter when several workers share one
external quota.
````

- [ ] **Step 2: Remove the duplicate Agent Chat worker start**

Replace the explicit start and its comment with:

```ts
// BUNDERSTACK_ROLE defaults to `all`, so backend.start() already owns the
// embedded queue worker. A split deployment uses `web`/`worker` roles and Redis.
```

Do not call `app.startWorker()` a second time. Update the README sentence to say the default `all` role auto-starts the embedded worker.

- [ ] **Step 3: Add matching Unreleased changelog entries**

Insert the same section into both changelog files so the packaging contract continues to see byte-identical copies:

```md
## [Unreleased]

### Changed

- **Continuous background-job concurrency.** Workers now fill declared
  concurrency above the internal ten-row claim batch and refill each freed slot
  immediately instead of waiting for the slowest job in a wave. Deterministic
  fixture ticks retain complete-wave execution.
```

- [ ] **Step 4: Run focused example and documentation-adjacent verification**

Run:

```bash
bun test packages/bunderstack/src/jobs packages/bunderstack/src/testing/jobs.test.ts
bunx tsc --noEmit -p examples/agent-chat/tsconfig.json
bun test scripts/packaging-contract.test.ts
```

Expected: all tests PASS, Agent Chat typechecks, and the two changelog files remain identical.

- [ ] **Step 5: Run repository verification**

Run:

```bash
bun run typecheck
bun run build
bun run verify:consumer
bun test
```

Expected: every command exits 0. `verify:consumer` reports no diagnostics from the widened low-level worker types.

- [ ] **Step 6: Commit documentation and consumer cleanup**

```bash
git add website/content/docs/background-jobs.mdx CHANGELOG.md packages/bunderstack/CHANGELOG.md examples/agent-chat/src/bunderstack.ts examples/agent-chat/README.md
git commit -m "docs(jobs): explain continuous worker concurrency"
```
