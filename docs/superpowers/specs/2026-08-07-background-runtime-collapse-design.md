# Background runtime collapse — one table, one tick, one artifact

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan
**Scope of this spec:** Phase 1. Phase 2 is sketched at the end and gets its own
spec when a sleeping host actually needs it.

## Goal

Bunderstack contains two independent implementations of "run this once,
reliably, with a lease": the queue (`_bunderstack_jobs`) and cron
(`_bunderstack_cron_runs`). They duplicate leasing, retries, attempt counting,
and crash recovery — and they have **diverged in capability**, with cron as the
poorer twin:

|               | `QueueJobDefinition` | `CronDefinition` |
| ------------- | -------------------- | ---------------- |
| `retries`     | yes                  | **no**           |
| `timeout`     | yes                  | **no**           |
| `concurrency` | yes                  | **no**           |
| `onFailed`    | yes                  | **no**           |

The practical consequence: **a cron handler that throws is never retried.** The
slot is recorded `failed` and nothing re-dispatches it, because each slot fires
once. Closing that gap without the collapse means implementing retries, backoff,
timeouts, and failure hooks a second time inside `cron-runner.ts`.

Collapse cron into the jobs table so there is one table, one loop, and one set
of semantics. Cron then inherits retries, timeout, and `onFailed` for free, and
any future work — dead-letter queue, admin view, metrics — is built once.

Separately but in the same release: make **topology a deployment concern rather
than an application concern**, so a self-hoster runs one container with no
decisions to make, and the platform can split roles without the developer
changing code.

The mental model this buys, stated in full:

> Everything in the background is a row in one table. A job is a type, a
> payload, a time to run, and an attempt count. A cron is a job that gets
> created on a schedule. `tick()` moves rows forward. You deploy one container;
> where the tick runs is your host's business, not yours.

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
Leasing, retry with backoff, crash recovery, and failure recording then fall out
of the queue worker for free.

## Core decisions

1. **Clean break, no compatibility shim.** `_bunderstack_cron_runs`,
   `cron-runner.ts`, `cron-router.ts`, `cron-auth.ts`, and `local-cron.ts` are
   deleted outright. Bunderstack is pre-1.0 (0.15.2); Bunderhost migrates in its
   own follow-up spec. Keeping the signed `/cron/:name` endpoint as an alias
   would preserve a second code path that exists only to be deleted later.
2. **No new columns on `_bunderstack_jobs`.** Cron rows are ordinary job rows
   distinguished by a reserved `cron:` type prefix. The only schema migration is
   dropping `_bunderstack_cron_runs`.
3. **Cron definitions gain the queue's options** — `retries`, `timeout`,
   `onFailed`. This is the user-visible payoff and the main reason to do the
   work. `concurrency` is meaningless for cron (slots are already unique) and is
   rejected at startup rather than silently ignored.
4. **`tick()` is the single entry point** for all background progress.
5. **The developer never selects a topology.** `BUNDERSTACK_ROLE` decides it,
   defaulting to `all`. The worker loop starts automatically; no user code calls
   it.
6. **The deployment unit is a container, not a platform-specific artifact.** One
   image runs on Fly, Cloudflare Containers, Railway, Render, Kamal, or a VPS.
   This keeps bunderstack Bun-native — no Workers rewrite, no loss of
   `Bun.Image`, `bun:sqlite`, or `Bun.S3Client`.
7. **Catch-up defaults to `latest`.** A cron that missed slots while the process
   was down materializes only its most recent due slot. `catchUp: 'all'` opts
   into every missed slot, bounded by `catchUpWindow`.
8. **The HTTP tick endpoint is deferred to Phase 2.** With `role=all`, or with
   always-on `web` + `worker`, it is never called. It is pure surface area until
   a host that sleeps needs it.

## Deployment model — one artifact, N topologies

`BUNDERSTACK_ROLE`, validated in `env.ts`, defaulting to `all`:

| value             | serves HTTP | runs the tick loop |
| ----------------- | ----------- | ------------------ |
| `all` _(default)_ | yes         | yes                |
| `web`             | yes         | no                 |
| `worker`          | no          | yes                |

**Self-hosting:** set nothing. One container, a few environment variables for
database and storage, and both HTTP and background work happen. There is no
second process to run and no decision to make.

**Platform:** Bunderhost sets the variable. The same image runs `all` for a
small app and splits into `web` + `worker` when one grows — invisibly, with no
change to application code.

The tick loop starts automatically inside `createBunderstack` when the resolved
role includes the worker, suppressed when `introspect` is set (build-time
manifest generation must not start background work) and overridable through
config for tests. `app.startWorker()` and `app.runWorker()` remain on the app
surface as escape hatches, consistent with the project's "re-export the raw
instances, never seal them" philosophy — they simply stop being the documented
path.

**Template changes:** `templates/tanstack-start-saas` drops its `worker` script
and `src/worker.ts` entry file. Booting the app is the whole deployment.

## Data model

`_bunderstack_cron_runs` is dropped. `_bunderstack_jobs` is unchanged:

| column                                              | queue jobs             | cron occurrences   |
| --------------------------------------------------- | ---------------------- | ------------------ |
| `type`                                              | job name               | `cron:<name>`      |
| `payloadJson`                                       | validated input        | `null`             |
| `runAt`                                             | when to run            | the slot timestamp |
| `dedupeKey`                                         | caller-supplied dedupe | `String(slot)`     |
| `status` / `attempts` / `lockedUntil` / `lastError` | identical              | identical          |

`validateJobsDefs` rejects any queue job whose name begins with `cron:`, so the
namespaces cannot collide. This is a startup error, not a runtime check.

In-flight `_bunderstack_cron_runs` rows are discarded by the migration. This is
safe: slots are derived from the schedule, so the next tick recomputes what is
owed. A slot mid-execution at migration time re-runs, consistent with the
at-least-once contract cron already had.

## The tick contract

```ts
export type TickResult = {
  /** Rows moved from pending to running this tick. */
  claimed: number
  /** Handlers that completed successfully. */
  ran: number
  /** Handlers that threw, whether or not they will be retried. */
  failed: number
}

tick(now?: number, opts?: { signal?: AbortSignal }): Promise<TickResult>
```

One tick performs, in order:

1. **Materialize cron slots.** For each declared cron, compute due slots and
   enqueue them.
2. **Recover expired leases.** Existing behavior: `running` rows whose
   `lockedUntil` has passed return to `pending`, or fail when attempts are
   exhausted.
3. **Drain claimable work.** Claim and run until nothing is claimable.
4. **Reap succeeded rows** — at most hourly, not every tick. Currently a delete
   is issued on every tick, which for an embedded worker means one delete per
   second forever to clean up rows older than 24h. Retention stays at 24h.

Phases are independently guarded: a failure in one is reported through
`onError` and the tick continues, so a broken cron definition cannot stop the
queue from draining.

## Cron materialization

```ts
slotsDue(def: CronDefinition, from: number, to: number): number[]
```

built on the existing `parseCron` / `cronMatches`, evaluated in UTC, matching
the five-field UTC convention already documented in the Bunderhost plan.

**Watermark:** `max(runAt) WHERE type = 'cron:<name>'`. When no rows exist — a
newly declared cron, or one whose rows were reaped — the watermark is `now`, so
a first deploy never backfills from epoch.

**Catch-up:**

- `catchUp: 'latest'` _(default)_ — materialize only the most recent due slot.
  Handlers are usually written to bring state up to date rather than to process
  one interval's work, and a long outage otherwise produces a stampede of
  near-identical runs.
- `catchUp: 'all'` — materialize every slot in `(watermark, now]`, clamped to
  `catchUpWindow` (default 1 hour). Correct when each slot represents distinct
  accumulated work. The clamp bounds the backlog: a `* * * * *` cron after a
  week of downtime materializes 60 slots, not 10,080.

Materialization is idempotent by construction. Two processes materializing the
same slot concurrently produce one row, because the unique constraint resolves
the race. This is what makes rolling deploys — where two containers briefly
overlap — safe without coordination.

## Correctness fixes folded in

Pre-existing defects in code this work already touches. In scope because the
collapse moves cron's guarantees onto the jobs path, and the jobs path is
currently the weaker of the two.

1. **Lease fencing on terminal updates.** `runJob` updates rows by `id` alone,
   so a worker that lost its lease (timeout, pause, partition) can still mark a
   row `succeeded` after another worker re-claimed and re-ran it. The cron path
   fences every update on an `(startedAt, attempts)` ownership tuple. Add
   `AND lockedUntil = <the lease this worker holds>` to the terminal updates in
   `runJob`, and treat a zero-row result as lost ownership.
2. **Backoff jitter.** `backoffMs` is deterministic, so every job failed by a
   shared outage retries at the same instant. Add proportional jitter.
3. **Reap off the hot path.** Move `reapSucceeded` to an hourly interval.
4. **Document `concurrency` as per-worker.** `runClaimable` reads the running
   count, computes capacity, then claims — two workers can both observe capacity
   and both take it. Enforcing this across processes needs the limit inside the
   claim statement, which is out of scope. Document the real semantics rather
   than leaving the guarantee implied.

## Surface changes

**Removed from `BunderstackApp`:** `startCronScheduler()`. It existed to run
cron locally in development; cron now runs through the same tick everywhere, so
the dev/prod split disappears. This removal is the point, not a casualty.

**Environment:** `BUNDERSTACK_CRON_SECRET` is removed. Signed dispatch is gone,
so nothing consumes it. Phase 2 introduces `BUNDERSTACK_TICK_SECRET` for the
HTTP profile. `BUNDERSTACK_ROLE` is added.

**Routes:** `/api/_bunderstack/cron/:name` and
`/api/_bunderstack/maintenance/:name` are removed. The hardcoded `storage-sweep`
maintenance task becomes an ordinary registered built-in cron, deleting its
special case in the router.

**Manifest:** continues to report cron schedules — useful for display and
validation — but the platform no longer needs them to dispatch. Manifest shape
changes are deferred to the Bunderhost spec.

## Error handling

- A handler that throws is retried with jittered backoff until attempts are
  exhausted, then set `failed` with `lastError`. This now applies to cron too.
- `failed` rows are never reaped. Existing behavior, deliberately retained — it
  is most of a dead-letter queue. A list/retry API is out of scope.
- A cron slot whose row is retrying is not re-materialized, because its dedupe
  key is already taken. The existing row retries on its own schedule.
- A tick that throws during materialization still drains, per the phase guards
  above.

## Testing

- `slotsDue` — table-driven, UTC, covering minute/hour/day/month/weekday fields,
  boundaries, and the watermark-absent case.
- Catch-up — `latest` picks the most recent slot; `all` respects
  `catchUpWindow`; neither backfills from epoch on first sight.
- Slot idempotency — concurrent ticks materializing the same slot produce one
  row and one execution.
- **Cron retry parity** — a throwing cron handler retries with backoff, honors
  `timeout`, and fires `onFailed` when attempts are exhausted. This is the
  regression test for the gap that motivates the work.
- Lease fencing — a worker that lost its lease cannot mark a re-claimed row
  succeeded.
- Reserved prefix — declaring a queue job named `cron:x` fails at startup.
- `concurrency` on a cron definition fails at startup.
- Role resolution — `all` / `web` / `worker` start the expected subsystems;
  `introspect` starts none; an invalid value fails at startup.
- Dialect parity — SQLite and Postgres, following the existing `*.pg.test.ts`
  pattern.

Existing cron tests (`cron-runner.test.ts`, `cron-router.test.ts`,
`cron-auth.test.ts`, `local-cron.test.ts`) are deleted with their modules. The
behaviors worth keeping — slot idempotency, lease recovery, retry on failure —
are re-expressed against the jobs path above.

## Out of scope

- **Phase 2** (below).
- **Bunderhost changes.** Role wiring, the migration off signed cron dispatch,
  and any Cloudflare Containers work. Its own spec, against this contract.
- **Dead-letter queue API.** Listing and retrying `failed` rows.
- **Cross-process `concurrency` enforcement.** Documented, not fixed.
- **Consolidating per-type claim queries.** `runClaimable` issues one claim per
  job type per tick; folding these into a single statement is a performance
  refactor with its own risk profile.
- **Realtime / Redis**, and **custom Hono route mounting** — separate threads,
  the latter with its own spec queued next.

---

## Phase 2 — the HTTP tick profile (deferred)

Not part of this plan. Recorded so Phase 1 does not foreclose it.

When a host sleeps — Cloudflare Containers, Fly with `auto_stop_machines`, a
Durable Object alarm — something must wake the process. After the collapse the
wake signal **carries no information**: the caller says "run," and the worker
derives what is owed from the database. Wake pings may therefore be lost,
duplicated, delayed, or reordered without affecting correctness.

That profile adds:

- `POST /api/_bunderstack/tick`, authenticated with `BUNDERSTACK_TICK_SECRET` —
  not for correctness, since the tick is idempotent, but to stop an untrusted
  caller repeatedly booting a machine and burning compute.
- `budgetMs` on `tick()` (default ~50s, under Fly's 60s proxy timeout), with the
  request held open while draining, so the platform's request-idleness signal is
  an accurate proxy for "work in flight" and native auto-stop is correct without
  custom exit logic.
- `drained: boolean` on `TickResult` — true when nothing was left claimable,
  false when the budget cut the drain short.
- `nextWakeAt: number | null` — `min(runAt)` over pending rows unioned with the
  next cron slot, letting a platform schedule one wake instead of polling. A
  missed wake self-heals on the following tick, so this is an optimization and
  never a correctness dependency.
- Graceful shutdown on `SIGTERM`: stop claiming, finish in-flight handlers, exit.
  `startJobWorker` already accepts an `AbortSignal`.

Known cost: cold start lands on job latency — roughly 1s from stopped, tens of
milliseconds from suspended. Latency-sensitive work belongs on `role=all`, where
the process is already awake.
