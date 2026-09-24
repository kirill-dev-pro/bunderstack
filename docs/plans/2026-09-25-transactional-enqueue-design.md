# Transactional Enqueue and Dedupe-Until-Start Design

## Problem

Two gaps surfaced while designing a profile hub on bunderstack: a service that
resolves incoming identity events into composite profiles and syncs every
changed profile to email-marketing providers.

### 1. `enqueue` cannot join the caller's transaction

The hub writes the merged profile and must schedule its sync atomically. Today
`app.jobs.enqueue()` and `ctx.jobs.enqueue()` always insert through the app's
root connection (`runtime.ts`, `enqueueJob(db, …)`). An application therefore
has two bad options:

- enqueue after commit: a crash between commit and enqueue loses the sync;
- enqueue before or during the transaction: a rollback leaves a job pointing at
  data that never existed, and the worker can claim it before the commit is
  visible.

The usual workaround is an application-owned outbox table plus a cron that
drains it into the queue. That duplicates what `_bunderstack_jobs` already is:
a durable table in the same database.

### 2. Dedupe collapses into a job that already started

`dedupeKey` is released only on a terminal state (`terminalPatch` in
`jobs/worker.ts`). While a job is `running`, a new enqueue with the same key
returns the running row's id. The handler has already read its input state, so
the newer change is silently dropped:

```
t0  enqueue syncPerson(p1)            -> job A pending
t1  worker claims A, reads profile v1
t2  profile updated to v2
t3  enqueue syncPerson(p1)            -> collapses into A (running)
t4  A pushes v1 and succeeds          -> v2 never synced
```

This is right for "at most one of these at a time" work, and wrong for the
common "coalesce bursts, but always process the latest state" pattern
(debounced sync, reindex, cache rebuild).

## Design

### Transactional enqueue: `{ tx }`

Add an optional `tx` to `EnqueueOptions`:

```ts
await context.db.transaction(async (tx) => {
  const person = await mergePerson(tx, event)
  await context.jobs.enqueue(
    'syncPerson',
    { personId: person.id },
    { tx, dedupeKey: `sync:${person.id}` },
  )
})
```

Implementation is small because `enqueueJob` already takes an `AnyDb`:

- `runtime.ts`: pass `opts.tx ?? db` to `enqueueJob`; strip `tx` from the
  options it forwards.
- `jobsTableFor(tx)` already resolves correctly: `PgTransaction` extends
  `PgDatabase`, and SQLite transactions extend `BaseSQLiteDatabase`.
- Guard: throw `[bunderstack] enqueue tx belongs to a different database
  dialect` when the dialect of `tx` differs from the app database. Passing a
  transaction from an unrelated connection of the same dialect cannot be
  detected cheaply; document it as unsupported.
- Types: `tx?: BunderstackTx<TSchema>` on the narrowed `JobsFacade`, and an
  `AnyDb`-shaped type on the loose runtime facade.

Semantics to document:

- The row becomes visible to workers only when the transaction commits; a
  rollback removes it. No worker change is needed.
- Postgres: an `ON CONFLICT DO NOTHING` insert that conflicts with an
  uncommitted row from another transaction waits for that transaction to end.
  Two transactions that enqueue the same `dedupeKey` therefore serialize on it.
  This is correct, but long transactions holding a hot key will block others.
- SQLite/libSQL: a write transaction already holds the database write lock, so
  there is no new contention.
- The two-round dedupe race loop stays valid inside a transaction: under
  `READ COMMITTED` the follow-up `select` sees rows committed by others, and the
  caller's own uncommitted insert is visible to itself.
- Delivery stays at-least-once. `tx` removes the lost-job and phantom-job cases;
  it does not make handlers exactly-once.

`fixture.app.jobs.enqueue(..., { tx })` works unchanged. Tests must cover
commit, rollback, and dedupe inside a transaction on both dialects
(`jobs.pg.test.ts`, `integration.test.ts`).

### Dedupe window: `dedupeUntil`

Add a per-definition option to queue jobs:

```ts
syncPerson: j.job({
  input: v.object({ personId: v.string() }),
  dedupeUntil: 'start', // 'finish' (default, current behavior) | 'start'
  retries: 5,
  handler: async ({ personId }, ctx) => { /* read latest, push */ },
})
```

- `'finish'`: the key is held until a terminal state. This is today's behavior
  and remains the default, so nothing changes for existing apps.
- `'start'`: the claim patch also sets `dedupeKey = null`. A burst of enqueues
  before the claim collapses into one row. An enqueue after the claim creates a
  new pending row, which runs after the current one and reads the newer state.

The claim in `jobs/worker.ts` is one batched `UPDATE … RETURNING` across job
types, not a per-definition step. The worker computes the set of types declared
with `'start'` once from `defs`, and the claim sets
`dedupeKey = CASE WHEN type IN (…) THEN NULL ELSE dedupe_key END`. When the set
is empty, the column is left out of the patch, so apps that do not use the
option get a byte-identical claim statement. Cron definitions reject
`dedupeUntil`: slot ownership depends on the retained key.

Edge cases to document:

- A `'start'` job that fails and is rescheduled for retry no longer holds its
  key, so a newer row can exist next to it and both run. That is acceptable
  under at-least-once delivery. Handlers of this kind read the latest state
  anyway.
- `'start'` does not bound concurrency per key: two rows for the same key can
  run at once if a second worker claims the newer row while the first is still
  running. Apps that need per-key serialization keep the default or take an
  advisory lock in the handler. A later option (`dedupeUntil: 'start'` plus
  per-key exclusivity) can close this if real apps need it.

Prior art: Sidekiq Enterprise unique jobs (`unique_until: :start` vs
`:success`), Oban `unique: [states: …]`.

## Out of scope

- A transactional `messaging.send`. The same `{ tx }` shape would fit the
  message journal, but sending calls a provider synchronously; it belongs to a
  separate design (enqueue-then-send).
- Exposing `enqueueJob` publicly. The `{ tx }` option covers the use case
  without leaking the internal definitions map.

## Verification

Red/green tests for:

1. enqueue with `tx`, then commit → row is claimable; rollback → no row
   (libSQL and Postgres);
2. dedupe inside a transaction collapses with an existing pending row;
3. a dialect-mismatched `tx` throws;
4. `dedupeUntil: 'start'`: enqueue while running creates a second row, and both
   run in order under `fixture.jobs.runUntilIdle()`;
5. `dedupeUntil: 'finish'` keeps the current collapse-into-running behavior;
6. cron definitions reject `dedupeUntil`.

Then run the full suite, type checking, consumer verification, and build. Ship
as a minor release (`0.25.0`) with the new options documented in `llms.txt`,
`llms-full.txt`, and the jobs docs page.
