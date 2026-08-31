# Continuous Job Worker Design

**Date:** 2026-08-31
**Status:** approved through design discussion

## Goal

Make a Bunderstack worker use the full declared job concurrency, including
values greater than ten, and refill capacity as soon as an active job finishes.
The improvement applies equally to the embedded worker used by
`BUNDERSTACK_ROLE=all` and to a dedicated process used by
`BUNDERSTACK_ROLE=worker`.

The current worker processes one wave at a time. A tick claims at most the
internal `CLAIM_BATCH = 10`, waits for the whole wave with `Promise.all`, sleeps
for the polling interval, and only then looks for more work. Consequently a
declaration such as `concurrency: 32` never starts more than ten jobs in one
worker loop, and one slow job leaves otherwise free slots idle until its entire
wave completes.

## Semantics

This change deliberately does not redefine the cross-process meaning of
`concurrency`. Its validation and public declaration shape stay unchanged, and
capacity continues to be calculated from the queue's currently `running` rows
as it is today. An omitted value retains the current effective single-worker
default of ten. Cron definitions still reject `concurrency` and use the same
default capacity for independently due slots.

The internal claim batch remains ten. It is a database-operation size, not an
execution limit. A worker with 32 free slots fills them using claims of
`10 + 10 + 10 + 2`. Small claims avoid unnecessarily large statements while
allowing any positive declared concurrency.

The production loop becomes a continuous pool:

```text
pump
  -> materialize cron slots, recover leases, reap retained rows
  -> calculate free capacity per type
  -> claim in batches until capacity or runnable work is exhausted
  -> start claimed handlers without awaiting the entire active set
  -> wait for the first active handler to settle or for the poll interval
  -> pump immediately
```

When one handler settles, its active slot is removed before the next pump. The
next runnable row can therefore start while unrelated slow handlers remain in
flight. Polling remains the fallback for new work that arrives while no handler
completion can wake the process.

## Deterministic ticks and production execution

`app.jobs.tick()` and the testing facade remain deterministic. One tick:

1. performs maintenance;
2. claims one complete wave up to each definition's available concurrency,
   using repeated internal batches;
3. awaits every row in that wave;
4. returns the existing `{ claimed, ran, failed }` report.

Work enqueued by a handler still belongs to a later deterministic tick. This
preserves `fixture.jobs.runNext()` and `runUntilIdle()` without introducing
background promises into tests.

The job runner gains a production-only pump alongside `tick()`. The pump owns
an in-memory active-task registry keyed by stored job type. It performs the
same durable claim and execution operations but returns after starting work.
Its result carries a promise that settles with the first active task, allowing
the generic polling loop to refill immediately without overlapping pump calls.

The active registry is process-local scheduling state, never a durability
source. `_bunderstack_jobs` remains canonical for status, attempts, leases,
retries, and crash recovery.

## Lifecycle and failures

Stopping a worker aborts polling and prevents new claims. `WorkerHandle.close()`
then waits for the runner's active tasks to settle, matching the current
behavior in which closing waits for an in-progress tick. Application shutdown
continues to close registered worker handles through the existing lifecycle.

Handler failures retain the current retry, backoff, terminal failure, and
`onFailed` behavior. A background execution promise must never become an
unhandled rejection: unexpected database/runtime errors are reported through
the worker logger and the row remains recoverable by its existing lease.

The fixed lease duration is unchanged. Lease renewal for work that legitimately
runs longer than `timeout` is a separate reliability project; this design does
not weaken the existing fencing check that prevents a worker which lost its
lease from marking a re-claimed row successful.

## Multi-process boundary

This change improves every individual process but does not redefine
distributed concurrency. Atomic row claims continue to prevent two workers
from owning the same pending row. Capacity is still observed before claim and
can race between processes, so the existing setting remains a best-effort
fleet-wide bound rather than a strict provider-wide semaphore.

A later worker-fleet project will separate `concurrencyPerWorker` from an
atomic `globalConcurrency`, add worker registration and heartbeat, and expose
autoscaling pressure to Bunderhost. None of those additions are required for a
single `all` process or one dedicated worker to benefit from continuous refill.

## Public surface

Application job definitions do not change. Low-level `startJobWorker()` remains
backward compatible with callers whose `tick` callback returns `Promise<void>`.
Its callback may additionally return a wake promise, and an internal drain
callback lets the Bunderstack application wait for active jobs on shutdown.
`AppStartWorkerOptions` does not expose the internal drain hook.

The background-jobs documentation will state that:

- the default per-type worker concurrency is ten;
- values greater than ten are supported;
- claims use bounded internal batches;
- a completed job refills a slot without waiting for its former wave.

## Testing

- A deterministic tick with `concurrency: 25` starts 25 handlers before any is
  released and leaves the remaining row pending.
- The production pump fills a declared capacity greater than ten using repeated
  claims.
- With concurrency two, completing one of two active jobs starts a third while
  the other original job is still blocked.
- The generic runtime wakes on task completion even when its polling interval
  is long and never overlaps pump calls.
- Closing stops new claims and waits for the active set to settle.
- Existing retry, cron, lease fencing, testing-facade, embedded-worker, and
  dedicated-worker tests remain green.

## Non-goals

- Worker pools or pool routing.
- Bunderhost autoscaling declarations or control-plane endpoints.
- Strict global concurrency across worker processes.
- Worker registration, process heartbeat, or graceful remote drain.
- Lease renewal or provider rate limiting.
- Changing queue persistence, retries, dedupe, cron, or retention semantics.
