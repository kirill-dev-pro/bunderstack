# Background Jobs (Queue + Cron)

**Date:** 2026-07-17
**Status:** Approved

## Goal

Bunderstack covers CRUD, auth, storage, realtime, email, and env — but has no
answer for "do slow work off the request path." Any app touching an LLM, image
API, or slow third-party service currently resorts to fire-and-forget
`void (async () => …)()`, which loses work on restart, has no retry, and no
concurrency control. This spec adds a durable, DB-backed job queue with an
in-process worker, plus cron scheduling layered on top of it.

Driving use case: the my-wardrobe app (see
`~/pet-projects/my-wardrobe/docs/bunderstack-jobs-usecase.md`) — Gemini image
calls taking 10–60 s, triggered from tRPC mutations, with progress delivered to
the client through the existing broadcast-on-write realtime.

Two concepts, one module:

- **Queue** — offloading and splitting work between workers: enqueue → claim →
  execute → retry.
- **Cron** — recurring schedules that _enqueue_ jobs on a cadence. The
  scheduler stays thin; all execution semantics live in the queue.

## Non-goals (v1)

- Dedicated worker processes / separate worker entrypoint (the table-based
  design doesn't preclude adding this later).
- Exactly-once delivery. The contract is **at-least-once + idempotent
  handlers**, consistent with the existing idempotency-table precedent.
- Priorities, rate-limit windows, job chaining/workflows, dashboard UI.
- Cron catch-up/backfill of slots missed while the app was down.

## Developer experience

`jobs` is a config key on `createBunderstack`, sibling to `storage`/`realtime`.
Like `trpc`, it accepts either an inline builder callback or a prebuilt import
— the extraction story for when the declaration grows.

```ts
// Inline — small apps
const app = await createBunderstack({
  schema,
  env: { server: { GEMINI_API_KEY: z.string() } },
  jobs: (j) =>
    j.define({
      generateLook: j.job({
        input: z.object({ generationId: z.number() }),
        retries: 3, // attempts after the first failure
        concurrency: 2, // max simultaneous runs of this type (cross-replica)
        timeout: 5 * 60_000, // lease duration; expired lease → back to pending
        handler: async (input, ctx) => {
          // ctx: { db, env, email, storage, jobs } — same capabilities as tRPC ctx
        },
        onFailed: async (input, error, ctx) => {
          // fires once, after the final attempt fails
        },
      }),
      nightlyCleanup: j.job({
        cron: '0 3 * * *', // a cron entry is an ordinary definition + `cron`
        handler: async (_, ctx) => {
          /* … */
        },
      }),
    }),
})

await app.jobs.enqueue(
  'generateLook',
  { generationId: 42 },
  {
    dedupeKey: `look:42`, // optional
    delay: 5_000, // optional; or runAt: Date
  },
)
```

```ts
// Extracted — jobs/ folder
// jobs/index.ts
import { createJobsBuilder } from 'bunderstack'

const j = createJobsBuilder<typeof schema, typeof envConfig>()
export const jobs = j.define({ generateLook, nightlyCleanup /* imported */ })

// app.ts
jobs: jobs
```

`createJobsBuilder` exists purely to carry ctx typing into extracted files,
mirroring `createTRPC`. Job names and payloads infer into `app.jobs.enqueue`
(and the client-facing types via `$inferClient` if ever needed) the same way
bucket names infer into storage — a typo'd name or wrong payload is a compile
error.

### Per-type options (all optional)

| Option        | Default                  | Meaning                                        |
| ------------- | ------------------------ | ---------------------------------------------- |
| `input`       | none (handler gets `{}`) | zod schema; payload parsed before the handler  |
| `retries`     | 3                        | attempts after the first failure               |
| `backoff`     | exponential, 1 s base    | `(attempt) => ms` or `{ baseMs, factor }`      |
| `concurrency` | unlimited                | max simultaneous `running` rows of this type   |
| `timeout`     | 60 s                     | lease duration                                 |
| `cron`        | none                     | cron expression; implies no enqueue-side input |
| `onFailed`    | none                     | called once after the final attempt fails      |

No queue-global config in v1; poll interval and retention are constants with
sensible defaults.

## Storage & claiming

One internal table `_bunderstack_jobs`, SQLite + PG twins in
`internal-tables.ts` / `internal-tables-pg.ts` next to the idempotency table,
exported from `bunderstack/schema(-pg)` so `provision(app)` and generated
migrations pick it up automatically. Columns:

```
id            text PK (typeid)
type          text NOT NULL
payload_json  text NOT NULL
status        text NOT NULL      -- pending | running | succeeded | failed
attempts      integer NOT NULL DEFAULT 0
run_at        integer NOT NULL   -- epoch ms; backoff & delay both land here
locked_until  integer            -- lease expiry while running
dedupe_key    text
last_error    text
created_at    integer NOT NULL
finished_at   integer
```

Indexes: `(status, run_at)` for claiming, `(type, status)` for concurrency
counts, and a **unique index on `(type, dedupe_key)`** — dedupe is a
constraint, not a check-then-insert race. Enqueue with a duplicate key is a
silent no-op returning the existing job's id. Dedupe lifetime differs by kind:

- **Non-cron jobs** clear `dedupe_key` (set NULL) when they reach a terminal
  status, so the key only guards while pending/running — double-click
  protection — and re-enqueueing after completion or failure ("retry button")
  just works.
- **Cron jobs** keep their key (`cron:<name>:<slotEpochMs>`) forever (until
  the row is reaped), so a slot can never fire twice even after it succeeds.
  Slot epochs are unique per slot, so reaping old rows can't cause refires.

Claiming goes behind the established `*TableFor(db)` dialect pattern:

- **Postgres:** `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction, then
  flip to `running` with `locked_until = now + timeout`.
- **libSQL/SQLite:** `UPDATE … SET status='running', locked_until=… WHERE id
IN (SELECT id … WHERE status='pending' AND run_at <= now LIMIT n) RETURNING`
  — atomic under SQLite's single-writer model.

The claim query excludes types whose `running` count has reached their
`concurrency` limit, so limits hold **across replicas**, not just in-process.

## Execution loop (in-process worker)

Every app instance runs the worker inside `Bun.serve` — running N replicas
gives N workers because the claim query distributes jobs. No new process
types; nothing for Bunderhost to learn beyond the manifest entry.

- Unref'd ~1 s poll interval (the storage sweep-timer pattern), plus an
  immediate wake after a local `enqueue` so same-process jobs start with no
  perceptible latency.
- **`attempts` increments at claim time**, not on failure — one place, and it
  makes crash accounting automatic (below).
- Handler success → `succeeded`, `finished_at` set.
- Handler failure → if `attempts <= retries`: `run_at = now +
backoff(attempts)`, back to `pending`. Otherwise: `failed`, error message
  stored in `last_error`, `onFailed` fires (its own errors are caught and
  logged, never retried).
- **Crash recovery:** on boot and on every poll, `running` rows with
  `locked_until < now` revert to `pending` (or `failed` if attempts are
  exhausted). The attempt was counted at claim time, so a crash consumes an
  attempt — this prevents a poison job from looping forever.
- **Retention:** `succeeded` rows older than 24 h are deleted by the same
  reaper pass. `failed` rows are kept (they're the debugging surface; manual
  re-enqueue is just calling `enqueue` again).
- Handler ctx is the tRPC ctx shape minus `req`/`user`: `{ db, env, email,
storage, jobs }`. `jobs` is included so jobs can enqueue jobs.

## Cron without a coordinator

Each replica, on every poll tick, computes each cron job's **current slot**
(the most recent time matching the expression) and enqueues it with
`dedupeKey: "cron:<name>:<slotEpochMs>"`. The unique dedupe index collapses
multi-replica firing to exactly one row — no leader election, no new
machinery.

- Missed slots while the app was down are **not** backfilled; only the current
  slot fires on boot.
- Overlap between consecutive slots is allowed by default; set
  `concurrency: 1` on the definition to serialize.
- Cron parsing: a minimal 5-field parser (minute granularity) implemented
  in-package — no new dependency for v1.

## Public surface

- `app.jobs.enqueue(name, input?, opts?)` — typed; `opts: { dedupeKey?,
delay? | runAt? }`. Returns `{ id: string }`.
- `ctx.jobs` in tRPC procedures — same facade.
- `app.manifest` gains a `jobs` section: declared job names + cron schedules,
  for Bunderhost introspection. Introspection mode
  (`BUNDERSTACK_INTROSPECT=1`) must not start the worker loop.
- Tests: the facade exposes `tick()` (claim + run one poll cycle
  deterministically, no timers) — the seam all queue tests drive.

## Error handling summary

| Situation                          | Behavior                                          |
| ---------------------------------- | ------------------------------------------------- |
| Handler throws, attempts remain    | backoff → `pending`, `last_error` updated         |
| Handler throws, attempts exhausted | `failed`, `onFailed(input, error, ctx)` fires     |
| Process crashes mid-job            | lease expires → `pending` (attempt already spent) |
| Duplicate `dedupeKey`              | no-op; existing job id returned                   |
| `enqueue` of unknown job name      | compile error (typed) + runtime throw             |
| Payload fails zod parse at enqueue | throw at enqueue site (fail fast, not in worker)  |
| Payload fails zod parse in worker  | `failed` immediately, no retries (schema drift)   |

## Testing

- Unit tests drive `tick()` directly — no real timers: enqueue/claim/retry/
  backoff/dedupe/lease-expiry/concurrency, on both dialects (the existing
  `*.test.ts` + `*.pg.test.ts` convention).
- Cron slot computation and the dedupe-collapse behavior tested by simulating
  two facades over one db.
- One integration test: tRPC mutation enqueues → worker runs → domain row
  updated → broadcast-on-write event observed (the my-wardrobe flow
  end-to-end).
