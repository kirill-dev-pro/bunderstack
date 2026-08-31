# Renewable Job Leases and Execution Deadlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a healthy long-running job from being retried after its lease expires, while giving handlers a separate cooperative execution deadline and observable lifecycle.

**Architecture:** Keep `_bunderstack_jobs.attempts` as the fencing generation and renew `lockedUntil` while a handler is alive. Add a distinct optional `maxRuntime`, pass an `AbortSignal` per invocation, and emit safe structured lifecycle events through the existing logger. Preserve `timeout` as a deprecated lease alias for compatibility.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, SQLite/Postgres job tables, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-31-renewable-job-leases-design.md`

## Global Constraints

- `timeout` remains a deprecated alias for `leaseDuration`; declaring both fails validation.
- `leaseDuration` defaults to exactly `60_000` ms; `maxRuntime` has no default.
- A deadline is cooperative and must never start a concurrent replacement while the original handler is unsettled.
- Lease ownership is fenced by job id, incremented attempt, running status, and the last observed `lockedUntil`.
- Job lifecycle logs never contain payloads, environment values, or secret-bearing exception stacks.
- `app.jobs.tick()` remains deterministic and existing worker shutdown still drains active handlers.
- Use Bun commands from `AGENTS.md`; public type changes require `bun run verify:consumer`.

---

### Task 1: Public timing and cancellation contract

**Files:**
- Modify: `packages/bunderstack/src/jobs/define.ts`
- Modify: `packages/bunderstack/src/jobs/index.ts`
- Test: `packages/bunderstack/src/jobs/define.test.ts`

**Interfaces:**
- Produces: `DEFAULT_LEASE_DURATION_MS`, `leaseDurationFor(def)`, `maxRuntime?: number`, `leaseDuration?: number`, and `JobContext.signal: AbortSignal`.
- Consumes: existing queue and cron definition builders.

- [ ] **Step 1: Write failing contract and validation tests**

Add tests that assert the builder preserves both new fields, the old field resolves as an alias, and invalid combinations fail:

```ts
test('background timing separates lease duration from execution deadline', () => {
  const defs = createJobsBuilder<any, any>().define({
    slow: {
      kind: 'job',
      leaseDuration: 30_000,
      maxRuntime: 600_000,
      handler: async (_input, ctx) => {
        expect(ctx.signal).toBeInstanceOf(AbortSignal)
      },
    },
  })
  expect(defs.slow.leaseDuration).toBe(30_000)
  expect(defs.slow.maxRuntime).toBe(600_000)
})

test('timeout remains a lease alias but cannot accompany leaseDuration', () => {
  expect(leaseDurationFor({ kind: 'job', timeout: 123, handler() {} })).toBe(123)
  expect(() => validateBackgroundDefs({
    invalid: {
      kind: 'job',
      timeout: 100,
      leaseDuration: 200,
      handler() {},
    },
  })).toThrow(/timeout.*leaseDuration/)
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test packages/bunderstack/src/jobs/define.test.ts`

Expected: FAIL because `leaseDuration`, `maxRuntime`, `signal`, and `leaseDurationFor` do not exist.

- [ ] **Step 3: Add the minimal public contract**

In `define.ts`, replace the timeout constant and repeated timing fields with:

```ts
export const DEFAULT_LEASE_DURATION_MS = 60_000
/** @deprecated Use DEFAULT_LEASE_DURATION_MS. */
export const DEFAULT_TIMEOUT_MS = DEFAULT_LEASE_DURATION_MS

type BackgroundTiming = {
  leaseDuration?: number
  maxRuntime?: number
  /** @deprecated Use leaseDuration. */
  timeout?: number
}

export function leaseDurationFor(def: BackgroundTiming): number {
  return def.leaseDuration ?? def.timeout ?? DEFAULT_LEASE_DURATION_MS
}
```

Make both queue and cron definitions extend `BackgroundTiming`, add
`signal: AbortSignal` to `JobContext`, validate positive finite integers for
both durations, and reject a definition carrying both alias names. Re-export
the new constant and helper from `jobs/index.ts` while retaining the old export.

- [ ] **Step 4: Run the focused tests and typecheck**

Run: `bun test packages/bunderstack/src/jobs/define.test.ts`

Expected: PASS.

Run: `bunx tsc --noEmit -p packages/bunderstack/tsconfig.json`

Expected: PASS; the runner invokes handlers through its existing erased internal
signature until Task 3 constructs the real per-invocation signal.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/define.test.ts packages/bunderstack/src/jobs/index.ts
git commit -m "feat(jobs): separate leases from execution deadlines"
```

---

### Task 2: Renewable, attempt-fenced lease ownership

**Files:**
- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`
- Test: `packages/bunderstack/src/jobs/worker.pg.test.ts`

**Interfaces:**
- Consumes: `leaseDurationFor(def)` from Task 1 and the claimed row's incremented `attempts`.
- Produces: internal `LeaseOwner`, serialized renewal, and terminal fencing used by Task 3.

- [ ] **Step 1: Write a failing long-running pump regression test**

Use a 90 ms lease and a handler gate. Pump once, wait beyond the original lease while pumping maintenance, and assert that the handler still ran once and the row remains attempt one:

```ts
test('pump renews a healthy handler instead of reclaiming it', async () => {
  const gate = deferred()
  let starts = 0
  const defs: JobsDefs = {
    slow: {
      kind: 'job',
      leaseDuration: 90,
      retries: 2,
      handler: async () => { starts++; await gate.promise },
    },
  }
  const r = runner(defs)
  const { id } = await enqueueJob(db, defs, 'slow')
  await r.pump()
  await Bun.sleep(140)
  await r.pump()
  expect(starts).toBe(1)
  expect((await rowById(id))?.attempts).toBe(1)
  gate.resolve()
  await r.drain()
  expect((await rowById(id))?.status).toBe('succeeded')
})
```

Add a second test that manually changes `attempts` while renewal is pending and asserts the stale handler cannot complete the row. Mirror the ownership predicate in the Postgres suite.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts`

Expected: FAIL because maintenance expires and reclaims the active row.

- [ ] **Step 3: Introduce mutable lease ownership**

In `worker.ts`, replace `ClaimedWork.leaseUntil` with:

```ts
type LeaseOwner = {
  attempt: number
  lockedUntil: number
}

type ClaimedWork = {
  row: JobRow
  def: AnyBackgroundDefinition
  owner: LeaseOwner
}
```

Build the owner from the incremented `attempts` returned by `claim()`. Change
recovery and every terminal/retry update to include `status = running`, the
attempt generation, and the observed `lockedUntil` in its predicate.

- [ ] **Step 4: Add serialized renewal and stop-before-terminal ordering**

Add a private heartbeat handle with this contract:

```ts
type LeaseHeartbeat = {
  owner: LeaseOwner
  lost: Promise<void>
  stop(): Promise<void>
}

function startLeaseHeartbeat(args: {
  row: JobRow
  def: AnyBackgroundDefinition
  owner: LeaseOwner
  onLost: () => void
}): LeaseHeartbeat
```

Schedule renewal every `Math.max(10, Math.floor(leaseDuration / 3))` ms. Chain
renewals through one promise, update `lockedUntil` only under the complete old
ownership predicate, mutate `owner.lockedUntil` after a successful update, and
call `onLost` after a zero-row update or database error. `stop()` clears the
timer and awaits the renewal chain. In `runJob`, always `await heartbeat.stop()`
before the final fenced database update.

- [ ] **Step 5: Make expired recovery race-safe**

For every row selected by `recoverExpiredLeases`, carry `lockedUntil` in the
selection and add the same attempt/status/lockedUntil predicate to the update.
If it updates zero rows, another heartbeat won the race; do not change status,
lastError, or invoke `onFailed`.

- [ ] **Step 6: Run SQLite and Postgres lease tests**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts`

Expected: PASS including the new single-execution assertion.

Run: `bun test packages/bunderstack/src/jobs/worker.pg.test.ts`

Expected: PASS when `TEST_DATABASE_URL` is configured; otherwise the suite must report its existing explicit skip rather than a failure.

- [ ] **Step 7: Commit renewable ownership**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/worker.pg.test.ts
git commit -m "fix(jobs): renew active job leases"
```

---

### Task 3: Cooperative deadlines, lease-loss cancellation, and lifecycle logs

**Files:**
- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`
- Test: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**
- Consumes: `LeaseHeartbeat` and `maxRuntime` from Tasks 1–2.
- Produces: one `AbortSignal` per invocation and safe structured lifecycle events.

- [ ] **Step 1: Write failing deadline and signal tests**

Add a handler that waits for its signal, records that the first attempt settled,
then succeeds on attempt two. Assert no second attempt starts before settlement:

```ts
test('execution deadline aborts before retrying', async () => {
  const events: string[] = []
  const defs: JobsDefs = {
    bounded: {
      kind: 'job',
      leaseDuration: 60,
      maxRuntime: 30,
      retries: 1,
      backoff: () => 0,
      handler: async (_input, ctx) => {
        events.push('start')
        if (events.filter((x) => x === 'start').length === 1) {
          await new Promise<void>((_resolve, reject) =>
            ctx.signal.addEventListener('abort', () => {
              events.push('aborted')
              reject(ctx.signal.reason)
            }, { once: true }),
          )
        }
      },
    },
  }
  const r = runner(defs)
  const { id } = await enqueueJob(db, defs, 'bounded')
  await r.pump()
  await Bun.sleep(40)
  await r.drain()
  await r.pump(Date.now())
  await r.drain()
  expect(events).toEqual(['start', 'aborted', 'start'])
  expect((await rowById(id))?.status).toBe('succeeded')
})
```

Add tests for a handler that swallows abort but returns (deadline still wins),
lease loss aborting with a different reason, and a captured logger receiving
`job.claimed`, `job.execution_timed_out`, `job.retrying`, and `job.completed`
without the payload.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/integration.test.ts`

Expected: FAIL because handler contexts lack signals and no deadline/log events exist.

- [ ] **Step 3: Create one invocation controller and context per run**

Define internal `JobExecutionTimeoutError` and `JobLeaseLostError` classes with
stable messages and no payload fields. Inside `runJob`, create an
`AbortController` and call the handler with:

```ts
const handlerCtx = { ...ctx, signal: controller.signal }
await def.handler(input, handlerCtx)
```

Pass `handlerCtx` to `onFailed` as well. Have the heartbeat's `onLost` abort the
controller with `JobLeaseLostError`. Remove the shared signal-less handler
context construction error introduced in Task 1.

- [ ] **Step 4: Enforce the cooperative execution deadline**

When `maxRuntime` exists, start a timer that aborts with
`JobExecutionTimeoutError(maxRuntime)`. Keep renewing the lease until the
handler settles. After settlement, clear the timer and check the signal reason;
if it is the execution-timeout error, route the attempt through existing retry
logic with `execution timed out after ${maxRuntime}ms` even if the handler
returned normally. A lease-loss reason returns `lost` and performs no row
mutation.

- [ ] **Step 5: Emit bounded structured events**

Add one helper in `worker.ts`:

```ts
function jobEvent(event: string, row: JobRow, fields: Record<string, unknown> = {}) {
  return {
    source: 'bunderstack.jobs',
    event,
    jobId: row.id,
    jobType: row.type,
    attempt: Number(row.attempts),
    ...fields,
  }
}
```

Serialize the helper result with `JSON.stringify` and use `logger.info`, `warn`,
and `error` for the six events named by the spec.
Compute `durationMs` from a real start timestamp. Include only normalized error
messages and never spread input, payload JSON, context, or raw error objects.

- [ ] **Step 6: Run job tests, integration tests, and typecheck**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/jobs/runtime.test.ts`

Expected: PASS.

Run: `bunx tsc --noEmit -p packages/bunderstack/tsconfig.json`

Expected: PASS.

- [ ] **Step 7: Commit deadline execution and logs**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/jobs/integration.test.ts packages/bunderstack/src/runtime.ts
git commit -m "feat(jobs): abort bounded executions safely"
```

---

### Task 4: Adopt the contract in agent chat

**Files:**
- Modify: `examples/agent-chat/src/bunderstack.ts`
- Modify: `examples/agent-chat/src/agent/runtime.ts`
- Test: `examples/agent-chat/src/agent/runtime.test.ts`
- Modify: `examples/agent-chat/README.md`

**Interfaces:**
- Consumes: `JobContext.signal`, `leaseDuration`, and `maxRuntime`.
- Produces: provider cancellation linked to queue deadline and lease ownership.

- [ ] **Step 1: Write a failing provider-abort test**

Add a responder that waits for `stream.signal.abort`, run `agentTurn` with an
already-aborted job-context signal, and assert the responder observes the same
reason and the run records a failure rather than remaining `running`.

- [ ] **Step 2: Run the test and confirm RED**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts`

Expected: FAIL because `runAgentTurn` does not link an outer signal.

- [ ] **Step 3: Link the job signal to the agent controller**

Add optional `signal?: AbortSignal` to the testable `AgentRuntimeContext`. In
`runAgentTurn`, link it to the existing controller and remove the listener in
the existing `finally` block:

```ts
const abortFromJob = () => abortController.abort(ctx.signal?.reason)
ctx.signal?.addEventListener('abort', abortFromJob, { once: true })
if (ctx.signal?.aborted) abortFromJob()
// existing work
ctx.signal?.removeEventListener('abort', abortFromJob)
```

Keep user cancellation behavior and `AgentRunCancelledError` classification
unchanged; a deadline reason must flow into the ordinary failure path.

- [ ] **Step 4: Configure agent job timing**

Change both `agentTurn` and `agentCommitment` definitions to:

```ts
leaseDuration: 30_000,
maxRuntime: 10 * 60_000,
```

Leave `agentReminder` unchanged. Update the README reliability section to state
that healthy jobs renew leases, agent work has a ten-minute cooperative
deadline, and handlers propagate the cancellation signal to the provider.

- [ ] **Step 5: Run the example tests and typecheck**

Run: `bun test examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/src/agent/messages.test.ts examples/agent-chat/src/agent/approvals.test.ts`

Expected: PASS.

Run: `bun run build && bunx tsc --noEmit -p examples/agent-chat/tsconfig.json`

Expected: PASS.

- [ ] **Step 6: Commit agent adoption**

```bash
git add examples/agent-chat/src/bunderstack.ts examples/agent-chat/src/agent/runtime.ts examples/agent-chat/src/agent/runtime.test.ts examples/agent-chat/README.md
git commit -m "fix(agent-chat): bound agent execution safely"
```

---

### Task 5: Public documentation, changelog, and complete verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-background-runtime-collapse-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-continuous-job-worker-design.md`
- Modify: `packages/bunderstack/CHANGELOG.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: final public names and behavior from Tasks 1–4.
- Produces: migration guidance for existing `timeout` declarations.

- [ ] **Step 1: Update durable-worker documentation**

Replace statements that leases are fixed or renewal is out of scope. Document:

```ts
emailDigest: j.job({
  leaseDuration: 30_000,
  maxRuntime: 5 * 60_000,
  handler: async (input, ctx) => {
    await fetch(input.url, { signal: ctx.signal })
  },
})
```

State that `timeout` keeps its old lease meaning for compatibility and should
be renamed to `leaseDuration`; it never becomes `maxRuntime` automatically.

- [ ] **Step 2: Add matching changelog entries**

Add identical unreleased entries to both changelogs covering renewable leases,
`ctx.signal`, `maxRuntime`, `leaseDuration`, and the deprecated alias. Do not
bump or publish a version in this implementation plan.

- [ ] **Step 3: Run formatting and the full verification matrix**

Run: `bun run fix`

Expected: exit 0 with only formatting changes in scoped files.

Run: `bun test packages/bunderstack/src/jobs/ examples/agent-chat/src/agent/`

Expected: 0 failures.

Run: `bun run typecheck:all`

Expected: exit 0.

Run: `bun run verify:consumer`

Expected: exit 0 and no diagnostics attributed to packed Bunderstack declarations.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Review scope against the spec**

Confirm the diff contains no job-attempt table, Bunderhost changes, global
concurrency work, forced promise termination, package version bump, or payload
logging.

- [ ] **Step 5: Commit documentation and release notes**

```bash
git add docs/superpowers/specs/2026-08-07-background-runtime-collapse-design.md docs/superpowers/specs/2026-08-31-continuous-job-worker-design.md packages/bunderstack/CHANGELOG.md CHANGELOG.md
git commit -m "docs(jobs): explain renewable leases"
```
