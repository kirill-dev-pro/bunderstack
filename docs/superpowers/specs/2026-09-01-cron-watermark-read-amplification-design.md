# Cron Watermark Read Amplification Design

**Date:** 2026-09-01
**Status:** approved

## Goal

Eliminate the remote-database read amplification caused by querying the newest
cron row on every background-worker cycle, without changing queue polling
latency, the application database, the public jobs API, or Bunderstack's
single-/multi-worker execution guarantees.

## Problem

Every worker cycle currently calls `cronWatermark()` once per declared cron:

```sql
select max(run_at) from _bunderstack_jobs where type = ?
```

The worker waits one second after each cycle. HR Breakers declares two cron
definitions, so Turso observed 23,600 executions of this query in six hours.
The existing `(type, dedupe_key)` index filters the cron type but cannot seek
the maximum `run_at`; the query scanned 3.51 million rows in that window.

Queue claim polling is not the source of the read amplification and stays out
of scope. The application continues to use its configured database as the
durable background store.

## Design

Each `createJobRunner()` instance owns an in-memory cursor per cron type:

```ts
type CronCursor = {
  checkedThrough: number
}
```

On first use, the runner hydrates the cursor once from durable history with an
indexed newest-row lookup:

```sql
select run_at
from _bunderstack_jobs
where type = ?
order by run_at desc
limit 1
```

When no row exists, the initial value remains one minute before the current
slot, preserving today's first-sight behavior. Subsequent cycles read the
cursor from memory. `slotsDue()` receives `checkedThrough` as its exclusive
lower bound. After a cycle proves that no matching slot exists, the cursor
advances to the current minute so an infrequent schedule does not repeatedly
rescan the same time range in memory. Cursor advancement is monotonic, so a
backward wall-clock adjustment cannot reopen already checked slots.

For due slots, the runner calls the existing constraint-backed `enqueueJob()`
oldest first. It advances the cursor after each successful enqueue. If an
enqueue throws, the cursor stays at the last successfully materialized slot,
and the next worker cycle retries the remaining range. After all due slots are
handled, it advances through the current minute.

## Multi-worker slot ownership

The in-memory cursor removes the database read that previously let a delayed
worker notice another worker's completed slot. Therefore cron rows must retain
their slot `dedupe_key` after reaching `succeeded` or `failed`. Queue jobs keep
their existing behavior and release their caller-supplied dedupe key on a
terminal status.

The existing unique index `(type, dedupe_key)` then remains the durable
exact-once boundary: workers may concurrently or sequentially attempt the same
slot, but all attempts resolve to one row. Succeeded cron rows are still reaped
after 24 hours. Failed rows retain their slot key along with the failed row;
future cron slots use different timestamp keys.

A newly started runner hydrates from the newest retained cron row. Existing
`catchUp`, `catchUpWindow`, retries, lease fencing, and handler input semantics
remain unchanged.

## Index

Add the same non-unique index to both database dialect twins:

```ts
index('bjq_type_run_at').on(t.type, t.runAt)
```

SQLite and Postgres can scan this index backwards for
`ORDER BY run_at DESC LIMIT 1`. Applications with committed migrations must
generate and apply a migration after upgrading. The one-time index build may
scan existing job rows; steady-state hydration reads at most one row per cron
per worker start.

## Error handling

- A hydration query failure leaves the cursor uninitialized and propagates the
  error; the next worker cycle retries hydration.
- A successful dedupe conflict counts as successful materialization because
  `enqueueJob()` returns the existing row.
- A failed enqueue does not advance past the failed slot.
- Cursor state is process-local and disposable. Durable rows remain the source
  used after every restart.

## Compatibility and non-goals

- No public configuration or API changes.
- No separate background database or Bunderhost infrastructure changes.
- No change to the one-second queue polling interval.
- No batching or redesign of claim, lease recovery, or reaping queries.
- No new system table.

Retaining dedupe keys on terminal cron rows is an internal semantic correction.
Terminal queue-job dedupe behavior remains backward compatible.

## Success criteria

1. One runner performs at most one durable watermark lookup per cron type
   during its lifetime.
2. Repeated ticks in the same minute perform no cron watermark reads and create
   no duplicate slots.
3. A later minute is materialized from the in-memory cursor even if prior
   history changes after hydration.
4. Two workers initialized before a due minute execute that minute's cron slot
   once even when the second worker ticks after the first handler completes.
5. Queue jobs release terminal dedupe keys; cron slots retain them.
6. The newest-row query is backed by `(type, run_at)` in SQLite and Postgres.
