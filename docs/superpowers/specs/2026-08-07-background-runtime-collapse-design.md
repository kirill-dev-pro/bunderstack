# Background runtime collapse — one table, one tick

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan

## Goal

Bunderstack currently contains two independent implementations of "run this
once, reliably, with a lease": the queue (`_bunderstack_jobs`) and cron
(`_bunderstack_cron_runs`). They duplicate leasing, retries, attempt counting,
and crash recovery, and cron additionally carries a heartbeat subsystem, an
HMAC-signed HTTP endpoint, a Hono router, and a separate development-only
scheduler.

Collapse cron into the jobs table so there is one table, one loop, and one
entry point. The resulting entry point — `tick()` — becomes the single seam
every hosting target plugs into, which in turn makes scale-to-zero workers
possible on Fly and makes Cloudflare Workers / Durable Object alarms viable
hosts for the background half.

The mental model this buys, stated in full:

> Everything in the background is a row in one table. A job is a type, a
> payload, a time to run, and an attempt count. A cron is a job that gets
> created on a schedule. `tick()` moves rows forward. Deploying means arranging
> for `tick()` to be called — embedded in your server, in a worker process, or
> by a ping from your platform.

## The observation this rests on

`_bunderstack_jobs` already carries `unique(type, dedupeKey)`, added for enqueue
deduplication. `_bunderstack_cron_runs` uses `primaryKey(taskId, scheduledAt)`
to make a cron slot run at most once. These are the same constraint.

Therefore: **a cron occurrence is a queue job whose dedupe key is its slot.**

```ts
enqueueJob(db, defs, `cron:${name}`, null, {
  runAt: slot,
  dedupeKey: String(slot),
})
```

`onConflictDoNothing` on that constraint gives exactly-once slot ownership
across every process and every instance, using machinery that already ships.
Everything cron needs — leasing, retry with backoff, crash recovery, failure
recording — then falls out of the queue worker for free.

## Core decisions

1. **Clean break, no compatibility shim.** `_bunderstack_cron_runs`,
   `cron-runner.ts`, `cron-router.ts`, `cron-auth.ts`, and `local-cron.ts` are
   deleted outright. Bunderstack is pre-1.0 (0.15.2); Bunderhost migrates to the
   new contract in its own follow-up spec. Rationale: keeping the signed
   `/cron/:name` endpoint as an alias preserves a second code path that exists
   only to be deleted later, and the deletion tends never to happen.
2. **No new columns on `_bunderstack_jobs`.** Cron rows are ordinary job rows
   distinguished by a reserved `cron:` type prefix. The only schema migration is
   dropping `_bunderstack_cron_runs`.
3. **`tick()` is the single entry point.** All three hosting profiles call the
   same function; they differ only in who calls it and whether a time budget
   applies.
4. **The wake signal carries no information.** After the collapse, a caller no
   longer says *which* cron and *which* slot. It says "run." The worker derives
   what is owed from the database. Wake pings may therefore be lost, duplicated,
   delayed, or reordered without affecting correctness.
5. **Catch-up defaults to `latest`.** A cron that missed slots while the process
   was down materializes only its most recent due slot. `catchUp: 'all'` opts
   into materializing every missed slot, bounded by `catchUpWindow`.
6. **The tick endpoint drains while the request is open.** This makes the
   platform's native request-idleness signal an accurate proxy for "work in
   flight," so Fly auto-stop is correct without custom exit logic.
7. **The tick endpoint is authenticated with a bearer token.** The tick is
   idempotent, so this is not a correctness control — it prevents an untrusted
   caller from repeatedly booting a scale-to-zero machine and burning compute.

## Data model

`_bunderstack_cron_runs` is dropped. `_bunderstack_jobs` is unchanged:

| column | role for queue jobs | role for cron occurrences |
|---|---|---|
| `type` | job name | `cron:<name>` |
| `payloadJson` | validated input | `null` |
| `runAt` | when to run | the slot timestamp |
| `dedupeKey` | caller-supplied dedupe | `String(slot)` |
| `status` / `attempts` / `lockedUntil` / `lastError` | identical | identical |

`validateJobsDefs` rejects any queue job whose name begins with `cron:`, so the
namespaces cannot collide. This is a startup-time error, not a runtime check.

In-flight `_bunderstack_cron_runs` rows are discarded by the migration. This is
safe: cron slots are derived from the schedule, so the next tick recomputes what
is owed. A slot that was mid-execution at migration time re-runs, which is
consistent with the at-least-once contract cron already had.

## The tick contract

```ts
export type TickResult = {
  /** Rows moved from pending to running this tick. */
  claimed: number
  /** Handlers that completed successfully. */
  ran: number
  /** Handlers that threw (whether or not they will be retried). */
  failed: number
  /** Earliest known future work, or null when the queue is empty. */
  nextWakeAt: number | null
  /** True when nothing was left claimable; false when the budget cut the drain short. */
  drained: boolean
}

tick(now?: number, opts?: {
  budgetMs?: number
  signal?: AbortSignal
}): Promise<TickResult>
```

One tick performs, in order:

1. **Materialize cron slots.** For each declared cron, compute due slots and
   enqueue them (see below).
2. **Recover expired leases.** Existing behavior: `running` rows whose
   `lockedUntil` has passed return to `pending`, or fail if attempts are
   exhausted.
3. **Drain claimable work.** Claim and run, looping until nothing is claimable
   or the budget expires. Today this runs a single pass; looping is what lets a
   woken worker empty a backlog in one request.
4. **Reap succeeded rows** — at most hourly, not every tick. Currently this
   issues a delete on every tick, which for an embedded worker means one delete
   per second forever to clean up rows older than 24h. The retention threshold
   itself is unchanged at 24h.
5. **Compute `nextWakeAt`** — `min(runAt)` over pending rows, unioned with the
   next slot of each declared cron.

`budgetMs` defaults to unbounded for the embedded and standalone profiles, and
to 50s for the HTTP profile (under Fly's 60s proxy timeout).

## Cron materialization

```ts
slotsDue(def: CronDefinition, from: number, to: number): number[]
```

built on the existing `parseCron` / `cronMatches`, evaluated in UTC (matching
the five-field UTC convention already documented in the Bunderhost plan).

**Watermark:** `max(runAt) WHERE type = 'cron:<name>'`. When no rows exist — a
newly declared cron, or one whose rows have been reaped — the watermark is
`now`, so a first deploy never backfills from epoch.

**Catch-up:**

- `catchUp: 'latest'` (default) — materialize only the most recent due slot.
  Chosen because handlers are usually written to bring state up to date rather
  than to process one interval's worth of work, and because a long outage
  otherwise produces a stampede of near-identical runs.
- `catchUp: 'all'` — materialize every slot in `(watermark, now]`, clamped to
  `catchUpWindow` (default 1 hour). Correct for handlers where each slot
  represents distinct accumulated work. The clamp bounds the backlog: a
  `* * * * *` cron after a week of downtime materializes 60 slots, not 10,080.

Materialization is idempotent by construction. Two workers materializing the
same slot concurrently produce one row, because the unique constraint resolves
the race — the same mechanism that makes the wake signal safe to duplicate.

## Hosting profiles

All three call the same `tick()`. They differ only in the driver.

**Embedded** (`app.startWorker()`) — ticks on an interval inside the web
process, no budget. Jobs enqueued during a request run immediately in-process.
This remains the lowest-latency profile and the default for single-machine
deployments.

**Standalone** (`app.runWorker()`) — the same loop in its own process. For long
or heavy jobs that should not share the web process, or when the web process
scales to zero.

**HTTP / scale-to-zero** — `POST /_bunderstack/tick`, bearer-authenticated,
drains under a budget, responds with `TickResult`. A Cloudflare `scheduled()`
handler, a Durable Object `alarm()`, a Fly proxy request, or a platform cron all
reduce to this profile.

### Scale-to-zero on Fly

Worker Machines today have no public Fly service and `restart_policy = always`,
which means the Fly proxy has no request to auto-start them on, so they must run
continuously. Adding the tick route makes them startable.

The request stays open while draining. Because Fly's auto-stop is driven by
in-flight requests, "no active requests" then means "no work in flight," and the
platform's native mechanism is correct without the app managing its own exit. If
the budget expires mid-drain, the response returns with `drained: false` and the
next wake resumes — no progress is lost, because progress is rows in the
database.

`nextWakeAt` lets the platform schedule one wake at the right moment instead of
polling every minute. Because a missed wake self-heals on the following tick,
this is a cost optimization and never a correctness dependency.

**Known cost:** cold start is added to job latency — roughly 1s from stopped,
tens of milliseconds from suspended. Workers should default to
`auto_stop_machines = "suspend"`. Latency-sensitive work belongs on the embedded
profile, where the web machine is already awake.

**Graceful shutdown:** on `SIGTERM`, stop claiming, finish in-flight handlers,
then exit. `startJobWorker` already accepts an `AbortSignal`, so the seam exists.

## Correctness fixes folded in

These are pre-existing defects in code this work already touches. They are in
scope because the collapse moves cron's guarantees onto the jobs path, and the
jobs path is currently the weaker of the two.

1. **Lease fencing on terminal updates.** `runJob` updates rows by `id` alone,
   so a worker that lost its lease (timeout, pause, partition) can still mark a
   row `succeeded` after another worker has re-claimed and re-run it. The cron
   path fences every update on an `(startedAt, attempts)` ownership tuple. Add
   `AND lockedUntil = <the lease this worker holds>` to the terminal updates in
   `runJob`, and treat a zero-row result as lost ownership.
2. **Backoff jitter.** `backoffMs` is deterministic, so every job failed by a
   shared outage retries at the same instant. Add proportional jitter.
3. **Reap off the hot path.** Move `reapSucceeded` to an interval.
4. **Document `concurrency` as per-worker.** `runClaimable` reads the running
   count, computes capacity, then claims — two workers can both observe capacity
   and both claim it. Enforcing this across processes needs the limit inside the
   claim statement, which is out of scope here. Document the current semantics
   honestly rather than leaving the guarantee implied.

## Surface changes

**Removed from `BunderstackApp`:** `startCronScheduler()`, which existed to run
cron locally in development. Cron now runs through the same tick as everything
else, so the development and production paths are identical — this removal is
the point, not a casualty.

**Environment:** `BUNDERSTACK_CRON_SECRET` becomes `BUNDERSTACK_TICK_SECRET`.
The concept is no longer cron-specific, and the validation rule changes from
"required when cron is configured in production" to "required when the HTTP tick
profile is enabled in production."

**Routes:** `/api/_bunderstack/cron/:name` and
`/api/_bunderstack/maintenance/:name` are replaced by
`POST /api/_bunderstack/tick`. The hardcoded `storage-sweep` maintenance task
becomes an ordinary registered built-in cron definition, deleting its special
case in the router.

**Manifest:** the manifest currently reports cron schedules so the platform can
dispatch them. It should continue to report them (they remain useful for display
and for validation) but the platform no longer needs them to dispatch. Adding
the tick endpoint and the wake-hint contract to the manifest is deferred to the
Bunderhost spec.

## Error handling

- A handler that throws is retried with jittered backoff until attempts are
  exhausted, then set `failed` with `lastError`. Unchanged from today.
- `failed` rows are never reaped. This is existing behavior and is deliberately
  retained — it is most of a dead-letter queue. A list/retry API is out of scope.
- A cron handler that throws behaves exactly like a failed job. The slot is not
  re-materialized, because its dedupe key is already taken; the existing row
  retries on its own schedule.
- A tick that throws during materialization must not prevent draining. Phases
  are independently guarded; a failure in one is reported and the tick continues.
- The HTTP tick returns 200 with a `TickResult` even when individual jobs
  failed. It returns 5xx only when the tick itself could not run — the caller is
  a scheduler, and job failure is not a scheduling failure.

## Testing

- `slotsDue` — table-driven, UTC, covering minute/hour/day/month/weekday fields,
  boundaries, and the watermark-absent case.
- Catch-up — `latest` picks the most recent slot; `all` respects
  `catchUpWindow`; neither backfills from epoch on first sight.
- Slot idempotency — concurrent ticks materializing the same slot produce one
  row and one execution.
- Budget — expiry mid-drain returns `drained: false`, and a subsequent tick
  completes the remaining work.
- `nextWakeAt` — correct across pending jobs only, cron only, both, and empty.
- Lease fencing — a worker that lost its lease cannot mark a re-claimed row
  succeeded.
- Reserved prefix — declaring a queue job named `cron:x` fails at startup.
- Dialect parity — SQLite and Postgres, following the existing `*.pg.test.ts`
  pattern.

Existing cron tests (`cron-runner.test.ts`, `cron-router.test.ts`,
`cron-auth.test.ts`, `local-cron.test.ts`) are deleted with their modules. The
behaviors worth keeping — slot idempotency, lease recovery, retry-on-failure —
are re-expressed against the jobs path in the tests above.

## Out of scope

- **Bunderhost changes.** Fly service configuration for worker Machines, the
  scheduler rewrite to consume `nextWakeAt`, and the migration off signed cron
  dispatch. These get their own spec against this contract.
- **Dead-letter queue API.** Listing and retrying `failed` rows.
- **Cross-process `concurrency` enforcement.** Documented, not fixed.
- **Consolidating per-type claim queries.** `runClaimable` issues one claim per
  job type per tick; folding these into a single statement is a performance
  refactor with its own risk profile.
- **Realtime / Redis.** A separate thread from the same exploration session.
- **Custom Hono route mounting.** Separate spec, queued next.
