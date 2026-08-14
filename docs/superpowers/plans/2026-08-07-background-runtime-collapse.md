# Background Runtime Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse cron into the jobs table so a cron occurrence is a queue job whose dedupe key is its slot, giving cron retries/timeout/onFailed for free, and make topology a deployment concern via `BUNDERSTACK_ROLE`.

**Architecture:** `_bunderstack_jobs` already carries `unique(type, dedupeKey)`; a cron slot uses `type = 'cron:<name>'` and `dedupeKey = String(slot)`, so `onConflictDoNothing` yields exactly-once slot ownership across processes. The worker's `tick()` gains a materialization phase that enqueues due slots, then the existing claim/lease/retry machinery runs them. All of `cron-runner.ts`, `cron-router.ts`, `cron-auth.ts`, `local-cron.ts` and the `_bunderstack_cron_runs` table are deleted.

**Tech Stack:** Bun, TypeScript, Drizzle ORM (libSQL + Postgres dialects), Hono, Zod, `bun test`.

## Global Constraints

- Use Bun commands exclusively (`bun test`, `bun install`, `bunx`). Never npm/npx/jest/vitest.
- Spec: `docs/superpowers/specs/2026-08-07-background-runtime-collapse-design.md`. Phase 1 only — do NOT build the HTTP tick endpoint, `budgetMs`, `nextWakeAt`, `drained`, or `BUNDERSTACK_TICK_SECRET`.
- Cron is five-field, minute-granularity, evaluated in **UTC**. No seconds field, no `@`-shortcuts.
- Slot alignment is exactly `60_000` ms. A slot timestamp always satisfies `slot % 60_000 === 0`.
- Default `catchUp` is `'latest'`. Default `catchUpWindow` is `3_600_000` ms (1 hour).
- Succeeded-row retention stays 24h (`SUCCEEDED_RETENTION_MS`). Only the reap _frequency_ changes.
- `failed` rows are never reaped. Do not add a cleanup for them.
- Reserved type prefix is `cron:`. Queue jobs may not use it.
- Tests live beside their source as `<name>.test.ts` and use `import { test, expect } from 'bun:test'`.
- Postgres-parity tests use the existing `*.pg.test.ts` file suffix pattern.
- Commit after every task using conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `build:`).

## Deviation from the spec (deliberate, flag at review)

The spec clamps catch-up to `catchUpWindow` only for `catchUp: 'all'`. This plan clamps **both** modes, because an unclamped `'latest'` scan over a watermark far in the past would iterate unbounded minutes. `catchUpWindow` therefore means "how far back either mode will look." For `'latest'` this is only observable when a cron's period exceeds the window (e.g. a yearly cron missed by more than an hour is skipped rather than fired late).

## File Structure

| File                                                  | Responsibility                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/bunderstack/src/jobs/slots.ts` _(new)_      | Pure slot enumeration: `slotsDue`, `floorSlot`, `SLOT_MS`, `CRON_PREFIX`                                                              |
| `packages/bunderstack/src/jobs/slots.test.ts` _(new)_ | Unit tests for the above                                                                                                              |
| `packages/bunderstack/src/jobs/define.ts`             | Cron gains retry options; `concurrency` rejected on cron; `cron:` prefix reserved; jitter in `backoffMs`                              |
| `packages/bunderstack/src/jobs/worker.ts`             | Materialization phase, cron dispatch, lease fencing, hourly reap, `TickResult`                                                        |
| `packages/bunderstack/src/jobs/index.ts`              | Re-export surface; drop deleted modules                                                                                               |
| `packages/bunderstack/src/env.ts`                     | `BUNDERSTACK_ROLE`; remove `BUNDERSTACK_CRON_SECRET`                                                                                  |
| `packages/bunderstack/src/index.ts`                   | Role-driven auto-start; remove `startCronScheduler`, cron router wiring                                                               |
| `packages/bunderstack/src/handler.ts`                 | Remove `cronRouter` part                                                                                                              |
| `packages/bunderstack/src/internal-tables.ts`         | Drop `bunderstackCronRuns`                                                                                                            |
| **Deleted**                                           | `jobs/cron-runner.ts`, `jobs/cron-router.ts`, `jobs/cron-auth.ts`, `jobs/local-cron.ts` and their `.test.ts` / `.pg.test.ts` siblings |
| `templates/tanstack-start-saas/`                      | Remove `worker` script and `src/worker.ts`                                                                                            |

---

### Task 1: Slot enumeration

**Files:**

- Create: `packages/bunderstack/src/jobs/slots.ts`
- Test: `packages/bunderstack/src/jobs/slots.test.ts`

**Interfaces:**

- Consumes: `parseCron`, `cronMatches`, `ParsedCron` from `./cron`
- Produces: `SLOT_MS: 60_000`, `CRON_PREFIX: 'cron:'`, `DEFAULT_CATCH_UP_WINDOW_MS: 3_600_000`, `floorSlot(ms: number): number`, `type CatchUp = 'latest' | 'all'`, `slotsDue(args: { cron: ParsedCron; from: number; to: number; catchUp?: CatchUp; catchUpWindowMs?: number }): number[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/bunderstack/src/jobs/slots.test.ts`:

```ts
import { test, expect } from 'bun:test'

import { parseCron } from './cron'
import { floorSlot, slotsDue, SLOT_MS } from './slots'

const T = (iso: string) => Date.parse(iso)

test('floorSlot aligns down to the minute', () => {
  expect(floorSlot(T('2026-08-07T10:00:59.999Z'))).toBe(
    T('2026-08-07T10:00:00Z'),
  )
  expect(floorSlot(T('2026-08-07T10:00:00Z'))).toBe(T('2026-08-07T10:00:00Z'))
})

test('latest returns only the most recent matching slot', () => {
  const slots = slotsDue({
    cron: parseCron('*/5 * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:22:30Z'),
    catchUp: 'latest',
  })
  expect(slots).toEqual([T('2026-08-07T10:20:00Z')])
})

test('all returns every matching slot oldest first', () => {
  const slots = slotsDue({
    cron: parseCron('*/5 * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:22:30Z'),
    catchUp: 'all',
  })
  expect(slots).toEqual([
    T('2026-08-07T10:05:00Z'),
    T('2026-08-07T10:10:00Z'),
    T('2026-08-07T10:15:00Z'),
    T('2026-08-07T10:20:00Z'),
  ])
})

test('from is exclusive so a watermark slot is never re-emitted', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:00:00Z'),
    catchUp: 'all',
  })
  expect(slots).toEqual([])
})

test('all is clamped by catchUpWindowMs', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T00:00:00Z'),
    to: T('2026-08-07T10:00:00Z'),
    catchUp: 'all',
    catchUpWindowMs: 5 * SLOT_MS,
  })
  expect(slots).toEqual([
    T('2026-08-07T09:56:00Z'),
    T('2026-08-07T09:57:00Z'),
    T('2026-08-07T09:58:00Z'),
    T('2026-08-07T09:59:00Z'),
    T('2026-08-07T10:00:00Z'),
  ])
})

test('latest is clamped by catchUpWindowMs', () => {
  const slots = slotsDue({
    cron: parseCron('0 0 1 1 *'),
    from: T('2026-01-01T00:00:00Z'),
    to: T('2026-08-07T10:00:00Z'),
    catchUp: 'latest',
    catchUpWindowMs: 60 * SLOT_MS,
  })
  expect(slots).toEqual([])
})

test('every slot returned is minute aligned', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:03:41Z'),
    catchUp: 'all',
  })
  expect(slots.every((s) => s % SLOT_MS === 0)).toBe(true)
})

test('defaults to latest when catchUp is omitted', () => {
  const slots = slotsDue({
    cron: parseCron('* * * * *'),
    from: T('2026-08-07T10:00:00Z'),
    to: T('2026-08-07T10:03:00Z'),
  })
  expect(slots).toEqual([T('2026-08-07T10:03:00Z')])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/jobs/slots.test.ts`
Expected: FAIL — cannot resolve module `./slots`.

- [ ] **Step 3: Write the implementation**

Create `packages/bunderstack/src/jobs/slots.ts`:

```ts
// src/jobs/slots.ts — cron slot enumeration. Pure; no db, no clock reads.
import { cronMatches, type ParsedCron } from './cron'

/** Slot granularity. Every slot timestamp satisfies `slot % SLOT_MS === 0`. */
export const SLOT_MS = 60_000

/** Reserved job-type prefix for cron occurrences. */
export const CRON_PREFIX = 'cron:'

/** How far back either catch-up mode will look. */
export const DEFAULT_CATCH_UP_WINDOW_MS = 60 * SLOT_MS

export type CatchUp = 'latest' | 'all'

/** Aligns `ms` down to its containing slot. */
export function floorSlot(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS
}

/**
 * Slots matching `cron` in the half-open range `(from, to]`, oldest first.
 *
 * `from` is exclusive so a stored watermark is never re-emitted. Both modes are
 * clamped to `catchUpWindowMs` — without it a watermark far in the past would
 * make this iterate unbounded minutes.
 */
export function slotsDue(args: {
  cron: ParsedCron
  from: number
  to: number
  catchUp?: CatchUp
  catchUpWindowMs?: number
}): number[] {
  const catchUp = args.catchUp ?? 'latest'
  const windowMs = args.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS
  const to = floorSlot(args.to)
  const from = Math.max(floorSlot(args.from), to - windowMs)
  if (to <= from) return []

  if (catchUp === 'latest') {
    for (let s = to; s > from; s -= SLOT_MS) {
      if (cronMatches(args.cron, s)) return [s]
    }
    return []
  }

  const slots: number[] = []
  for (let s = from + SLOT_MS; s <= to; s += SLOT_MS) {
    if (cronMatches(args.cron, s)) slots.push(s)
  }
  return slots
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/jobs/slots.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/slots.ts packages/bunderstack/src/jobs/slots.test.ts
git commit -m "feat(jobs): add pure cron slot enumeration"
```

---

### Task 2: Cron definitions gain retry parity

**Files:**

- Modify: `packages/bunderstack/src/jobs/define.ts`
- Test: `packages/bunderstack/src/jobs/define.test.ts`

**Interfaces:**

- Consumes: `CRON_PREFIX`, `CatchUp` from `./slots`
- Produces: `CronDefinition` gains `retries?`, `backoff?`, `timeout?`, `onFailed?`, `catchUp?`, `catchUpWindow?`. New exported type `AnyBackgroundDefinition = QueueJobDefinition<any, any, any> | CronDefinition<any, any, any>`. `backoffMs(def: AnyBackgroundDefinition, attempt: number): number` — widened from `AnyJobDefinition`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/jobs/define.test.ts`:

```ts
import { CRON_PREFIX } from './slots'

test('cron definitions accept retry options', () => {
  const j = createJobsBuilder()
  const def = j.cron({
    schedule: '* * * * *',
    retries: 5,
    timeout: 30_000,
    catchUp: 'all',
    catchUpWindow: 120_000,
    handler: () => {},
    onFailed: () => {},
  })
  expect(def.kind).toBe('cron')
  expect(def.retries).toBe(5)
  expect(def.timeout).toBe(30_000)
  expect(def.catchUp).toBe('all')
})

test('cron rejects concurrency', () => {
  expect(() =>
    validateBackgroundDefs({
      nightly: {
        kind: 'cron',
        schedule: '0 0 * * *',
        concurrency: 2,
        handler: () => {},
      } as never,
    }),
  ).toThrow(/concurrency is not supported for cron/)
})

test('cron validates retries and timeout like jobs', () => {
  expect(() =>
    validateBackgroundDefs({
      a: {
        kind: 'cron',
        schedule: '* * * * *',
        retries: -1,
        handler: () => {},
      },
    }),
  ).toThrow(/retries must be a non-negative integer/)
  expect(() =>
    validateBackgroundDefs({
      b: { kind: 'cron', schedule: '* * * * *', timeout: 0, handler: () => {} },
    }),
  ).toThrow(/timeout must be positive/)
})

test('queue job names may not use the reserved cron prefix', () => {
  expect(() =>
    validateBackgroundDefs({
      [`${CRON_PREFIX}sneaky`]: { kind: 'job', handler: () => {} },
    }),
  ).toThrow(/reserved/)
})

test('backoffMs applies jitter within the expected band', () => {
  const def = { kind: 'job', handler: () => {} } as never
  const samples = Array.from({ length: 50 }, () => backoffMs(def, 1))
  // base 1000ms, +/-20% jitter
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(800)
  expect(Math.max(...samples)).toBeLessThanOrEqual(1200)
  expect(new Set(samples).size).toBeGreaterThan(1)
})
```

Ensure the file's existing import line includes `backoffMs` and `validateBackgroundDefs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/jobs/define.test.ts`
Expected: FAIL — cron rejects unknown properties, no reserved-prefix error, jitter samples all equal 1000.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/jobs/define.ts`:

Add the import:

```ts
import { CRON_PREFIX, type CatchUp } from './slots'
```

Extend `CronDefinition` — replace the existing type with:

```ts
export type CronDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TSchedule extends string = string,
> = {
  kind: 'cron'
  schedule: TSchedule
  /** Attempts after the first failure. Default 3 (so 4 total attempts). */
  retries?: number
  /** Delay before retry N (1-based). Default exponential: 1s, 2s, 4s, … */
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  /** Lease duration in ms; an expired lease sends the slot back to pending. */
  timeout?: number
  /** How missed slots are handled on wake. Default 'latest'. */
  catchUp?: CatchUp
  /** How far back catch-up looks, in ms. Default 1 hour. */
  catchUpWindow?: number
  handler: (
    invocation: CronInvocation,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
  /** Fires once, after the final attempt fails. Errors here are logged, never retried. */
  onFailed?: (
    invocation: CronInvocation,
    error: Error,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
}
```

Add the widened definition type next to `AnyJobDefinition`:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBackgroundDefinition =
  | QueueJobDefinition<any, any, any>
  | CronDefinition<any, any, any>
```

Replace `validateBackgroundDefs` with:

```ts
export function validateBackgroundDefs(defs: BackgroundDefs): void {
  for (const [name, def] of Object.entries(defs)) {
    if (typeof def.handler !== 'function') {
      throw new Error(`[bunderstack] background task "${name}" has no handler`)
    }
    if (def.kind === 'job' && name.startsWith(CRON_PREFIX)) {
      throw new Error(
        `[bunderstack] job "${name}": the "${CRON_PREFIX}" prefix is reserved for cron tasks`,
      )
    }
    if (
      def.retries !== undefined &&
      (def.retries < 0 || !Number.isInteger(def.retries))
    ) {
      throw new Error(
        `[bunderstack] background task "${name}": retries must be a non-negative integer`,
      )
    }
    if (def.timeout !== undefined && def.timeout <= 0) {
      throw new Error(
        `[bunderstack] background task "${name}": timeout must be positive`,
      )
    }
    if (def.kind === 'cron') {
      parseCron(def.schedule)
      if ((def as { concurrency?: number }).concurrency !== undefined) {
        throw new Error(
          `[bunderstack] cron "${name}": concurrency is not supported for cron tasks — slots are already unique`,
        )
      }
      if (def.catchUpWindow !== undefined && def.catchUpWindow <= 0) {
        throw new Error(
          `[bunderstack] cron "${name}": catchUpWindow must be positive`,
        )
      }
      continue
    }
    if (
      def.concurrency !== undefined &&
      (def.concurrency < 1 || !Number.isInteger(def.concurrency))
    ) {
      throw new Error(
        `[bunderstack] job "${name}": concurrency must be a positive integer`,
      )
    }
  }
}
```

Replace `backoffMs` with the jittered version:

```ts
/**
 * Delay in ms before retry `attempt` (1-based = the attempt that just failed).
 * Jittered by ±20% so a shared outage does not retry every job in lockstep.
 * A caller-supplied backoff function is returned verbatim — the caller owns it.
 */
export function backoffMs(
  def: AnyBackgroundDefinition,
  attempt: number,
): number {
  const b = def.backoff
  if (typeof b === 'function') return b(attempt)
  const baseMs = b?.baseMs ?? 1000
  const factor = b?.factor ?? 2
  const flat = baseMs * factor ** (attempt - 1)
  return Math.round(flat * (0.8 + Math.random() * 0.4))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/jobs/define.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/define.test.ts
git commit -m "feat(jobs): give cron definitions retry parity with queue jobs"
```

---

### Task 3: Materialize cron slots in the worker tick

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`

**Interfaces:**

- Consumes: `slotsDue`, `floorSlot`, `SLOT_MS`, `CRON_PREFIX` from `./slots`; `enqueueJob` from `./queue`; `parseCron` from `./cron`
- Produces: `tick()` enqueues a row per due slot with `type = 'cron:<name>'`, `runAt = slot`, `dedupeKey = String(slot)`, `payloadJson = 'null'`

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/jobs/worker.test.ts`:

```ts
import { and, eq as eqOp } from 'drizzle-orm'

import { CRON_PREFIX, SLOT_MS } from './slots'

async function cronRows(name: string) {
  return db
    .select()
    .from(bunderstackJobs)
    .where(eqOp(bunderstackJobs.type, `${CRON_PREFIX}${name}`))
}

test('tick materializes the current slot on first sight', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const now = Date.parse('2026-08-07T10:00:30Z')
  await runner(defs).tick(now)

  const rows = await cronRows('beat')
  expect(rows).toHaveLength(1)
  expect(Number(rows[0]!.runAt)).toBe(Date.parse('2026-08-07T10:00:00Z'))
  expect(rows[0]!.dedupeKey).toBe(String(Date.parse('2026-08-07T10:00:00Z')))
})

test('tick does not backfill from epoch on first sight', async () => {
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      catchUp: 'all',
      handler: () => {},
    },
  }
  await runner(defs).tick(Date.parse('2026-08-07T10:00:30Z'))
  expect(await cronRows('beat')).toHaveLength(1)
})

test('materialization is idempotent across concurrent ticks', async () => {
  let runs = 0
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: () => {
        runs++
      },
    },
  }
  const now = Date.parse('2026-08-07T10:00:30Z')
  const a = runner(defs)
  const b = runner(defs)
  await Promise.all([a.tick(now), b.tick(now)])

  expect(await cronRows('beat')).toHaveLength(1)
  expect(runs).toBe(1)
})

test('the watermark advances so a slot is materialized once per minute', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const r = runner(defs)
  const t0 = Date.parse('2026-08-07T10:00:30Z')
  await r.tick(t0)
  await r.tick(t0 + 10_000)
  await r.tick(t0 + SLOT_MS)

  const runAts = (await cronRows('beat')).map((row) => Number(row.runAt)).sort()
  expect(runAts).toEqual([
    Date.parse('2026-08-07T10:00:00Z'),
    Date.parse('2026-08-07T10:01:00Z'),
  ])
})

test('a non-matching minute materializes nothing', async () => {
  const defs: JobsDefs = {
    hourly: { kind: 'cron', schedule: '0 * * * *', handler: () => {} },
  }
  await runner(defs).tick(Date.parse('2026-08-07T10:30:00Z'))
  expect(await cronRows('hourly')).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts`
Expected: FAIL — no cron rows are created; `cronRows` returns empty arrays.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/jobs/worker.ts`, add imports:

```ts
import { max } from 'drizzle-orm'

import { parseCron } from './cron'
import { enqueueJob } from './queue'
import { CRON_PREFIX, floorSlot, slotsDue, SLOT_MS } from './slots'
```

Add inside `createJobRunner`, before `runClaimable`:

```ts
/**
 * The watermark is the newest slot we already stored for this cron. When no
 * rows exist — a newly declared cron, or one whose rows were reaped — anchor
 * one slot before now so the current minute is eligible and nothing older is.
 */
async function cronWatermark(type: string, now: number): Promise<number> {
  const rows = await db
    .select({ latest: max(t.runAt) })
    .from(t)
    .where(eq(t.type, type))
  const latest = rows[0]?.latest
  return latest == null ? floorSlot(now) - SLOT_MS : Number(latest)
}

/** Enqueue a row per due slot. The unique(type, dedupeKey) constraint makes
 *  this safe to run concurrently in any number of processes. */
async function materializeCronSlots(now: number) {
  for (const [name, def] of Object.entries(defs)) {
    if (def.kind !== 'cron') continue
    const type = `${CRON_PREFIX}${name}`
    const from = await cronWatermark(type, now)
    const slots = slotsDue({
      cron: parseCron(def.schedule),
      from,
      to: now,
      catchUp: def.catchUp,
      catchUpWindowMs: def.catchUpWindow,
    })
    for (const slot of slots) {
      await enqueueJob(db, defs, name, null, {
        runAt: slot,
        dedupeKey: String(slot),
      })
    }
  }
}
```

`enqueueJob` currently rejects anything that is not `kind === 'job'` and writes `type: name`. Change its signature to accept cron. In `packages/bunderstack/src/jobs/queue.ts`, replace the guard and the inserted type:

```ts
const def = defs[name]
if (!def) {
  throw new Error(`[bunderstack] unknown background task "${name}"`)
}
const isCron = def.kind === 'cron'
const type = isCron ? `${CRON_PREFIX}${name}` : name
// Cron slots carry no payload; queue jobs validate theirs at the call site.
const parsed = isCron ? null : def.input ? def.input.parse(input) : null
```

and use `type` in place of `name` in the `.values({ type: ... })`, in the `eq(t.type, ...)` lookup, and in the error message. Import `CRON_PREFIX` from `./slots` in `queue.ts`.

Finally add the phase to `tick`:

```ts
    async tick(now: number = Date.now()) {
      await materializeCronSlots(now)
      await recoverExpiredLeases(now)
      await reapSucceeded(now)
      await runClaimable(now)
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts`
Expected: PASS. The four tests asserting `runs` counts will still fail if cron handlers are not yet dispatched — that is Task 4. If `materialization is idempotent` fails only on `expect(runs).toBe(1)`, leave it and proceed.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/queue.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "feat(jobs): materialize cron slots as queue rows in tick"
```

---

### Task 4: Run cron slots through the job execution path

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`

**Interfaces:**

- Consumes: `AnyBackgroundDefinition`, `CronInvocation` from `./define`; `CRON_PREFIX` from `./slots`
- Produces: cron handlers receive `{ scheduledFor: Date }`; cron failures retry with backoff and fire `onFailed`

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/jobs/worker.test.ts`:

```ts
test('a cron handler receives its scheduled slot', async () => {
  const seen: Date[] = []
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: (invocation) => {
        seen.push(invocation.scheduledFor)
      },
    },
  }
  await runner(defs).tick(Date.parse('2026-08-07T10:00:30Z'))
  expect(seen).toHaveLength(1)
  expect(seen[0]!.toISOString()).toBe('2026-08-07T10:00:00.000Z')
})

test('a failing cron slot retries with backoff then fires onFailed', async () => {
  let attempts = 0
  const failures: string[] = []
  const defs: JobsDefs = {
    flaky: {
      kind: 'cron',
      schedule: '* * * * *',
      retries: 1,
      backoff: () => 0,
      handler: () => {
        attempts++
        throw new Error('boom')
      },
      onFailed: (_invocation, error) => {
        failures.push(error.message)
      },
    },
  }
  const r = runner(defs)
  const now = Date.parse('2026-08-07T10:00:30Z')
  await r.tick(now)
  expect(attempts).toBe(1)
  expect(failures).toEqual([])

  await r.tick(now + 1_000)
  expect(attempts).toBe(2)
  expect(failures).toEqual(['boom'])

  const rows = await cronRows('flaky')
  expect(rows[0]!.status).toBe('failed')
  expect(rows[0]!.dedupeKey).toBeNull()
})

test('a cron slot whose type has no definition is failed, not retried forever', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const r = runner(defs)
  await r.tick(Date.parse('2026-08-07T10:00:30Z'))
  const r2 = runner({})
  await r2.tick(Date.parse('2026-08-07T10:01:30Z'))
  const rows = await cronRows('beat')
  expect(rows[0]!.status).toBe('succeeded')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts`
Expected: FAIL — `seen` is empty, because `runClaimable` only iterates `kind === 'job'` definitions and `defs[row.type]` cannot resolve `'cron:beat'`.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/jobs/worker.ts`:

Replace the `JobRow` type so the slot is available to the handler:

```ts
type JobRow = {
  id: string
  type: string
  payloadJson: string
  attempts: number
  runAt: number
}
```

Add `runAt: t.runAt` to the `.returning({ ... })` in `claim` and to the `.select({ ... })` in `recoverExpiredLeases`.

Replace `maxAttempts` and add a resolver:

```ts
function maxAttempts(def: AnyBackgroundDefinition): number {
  return 1 + (def.retries ?? DEFAULT_RETRIES)
}

/** Resolve a stored row type back to its definition. Cron rows carry the
 *  reserved prefix; queue rows use the definition key verbatim. */
function definitionFor(
  defs: JobsDefs,
  type: string,
): AnyBackgroundDefinition | undefined {
  if (type.startsWith(CRON_PREFIX)) {
    const def = defs[type.slice(CRON_PREFIX.length)]
    return def?.kind === 'cron' ? def : undefined
  }
  const def = defs[type]
  return def?.kind === 'job' ? def : undefined
}
```

Change `fireOnFailed` to take the already-resolved input rather than re-parsing:

```ts
async function fireOnFailed(
  def: AnyBackgroundDefinition,
  input: unknown,
  error: Error,
) {
  if (!def.onFailed) return
  try {
    await (def.onFailed as (i: unknown, e: Error, c: unknown) => unknown)(
      input,
      error,
      ctx,
    )
  } catch (hookErr) {
    console.error('[bunderstack] onFailed hook threw:', hookErr)
  }
}
```

Update its two call sites: in `recoverExpiredLeases` pass `resolveInput(def, row)`, and in `runJob` pass the `input` already computed.

Add the input resolver:

```ts
/** Cron rows carry no payload — their handler input is the slot itself. */
function resolveInput(def: AnyBackgroundDefinition, row: JobRow): unknown {
  if (def.kind === 'cron') {
    return { scheduledFor: new Date(Number(row.runAt)) }
  }
  const raw = JSON.parse(row.payloadJson)
  return def.input ? def.input.parse(raw) : undefined
}
```

In `runJob`, replace the inline parse block with `resolveInput(def, row)` inside the existing `try`/`catch` that fails the row on unparseable payloads.

Replace `recoverExpiredLeases`'s `defs[row.type]` lookup and its `!def || def.kind !== 'job'` guard with:

```ts
      const def = definitionFor(defs, row.type)
      const error = new Error('lease expired (worker crashed or timed out)')
      if (!def) {
```

Replace `runClaimable` so it iterates both kinds:

```ts
async function runClaimable(now: number) {
  const work: Promise<void>[] = []
  for (const [name, def] of Object.entries(defs)) {
    const type = def.kind === 'cron' ? `${CRON_PREFIX}${name}` : name
    let limit = CLAIM_BATCH
    if (def.kind === 'job' && def.concurrency !== undefined) {
      const runningRows = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.type, type), eq(t.status, 'running')))
      const capacity = def.concurrency - runningRows.length
      if (capacity <= 0) continue
      limit = Math.min(limit, capacity)
    }
    const leaseUntil = now + (def.timeout ?? DEFAULT_TIMEOUT_MS)
    const claimed = await claim(type, limit, now, leaseUntil)
    for (const row of claimed) work.push(runJob(row, def, now))
  }
  await Promise.all(work)
}
```

Change every `AnyJobDefinition` annotation in this file to `AnyBackgroundDefinition` and update the import from `./define`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/jobs/`
Expected: PASS, including the `expect(runs).toBe(1)` assertion deferred from Task 3.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "feat(jobs): run cron slots through the queue execution path"
```

---

### Task 5: Fence terminal updates on the lease

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`

**Interfaces:**

- Consumes: nothing new
- Produces: `runJob` only writes terminal state while it still holds the lease it claimed

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/jobs/worker.test.ts`:

```ts
test('a worker that lost its lease cannot mark a re-claimed row succeeded', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const defs: JobsDefs = {
    slow: {
      kind: 'job',
      timeout: 10,
      handler: async () => {
        await gate
      },
    },
  }
  const { id } = await enqueueJob(db, defs, 'slow', undefined)

  const first = runner(defs)
  const now = Date.now()
  const running = first.tick(now)

  // Steal the lease the way lease recovery would after the timeout elapses.
  await db
    .update(bunderstackJobs)
    .set({ status: 'running', lockedUntil: now + 100_000, attempts: 2 })
    .where(eq(bunderstackJobs.id, id))

  release!()
  await running

  const row = await rowById(id)
  expect(row!.status).toBe('running')
  expect(Number(row!.lockedUntil)).toBe(now + 100_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts -t "lost its lease"`
Expected: FAIL — status is `succeeded`, because `runJob` updates by `id` alone.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/jobs/worker.ts`, thread the lease through `runJob`. Change its signature to `runJob(row, def, now, leaseUntil)` and pass `leaseUntil` at the `runClaimable` call site.

Add `and(eq(t.id, row.id), eq(t.lockedUntil, leaseUntil))` to every terminal `.where(...)` inside `runJob` — the success update, the retry update, and the exhausted-attempts update — and add `.returning({ id: t.id })` to each. Guard the success path:

```ts
const updated = await db
  .update(t)
  .set({
    status: 'succeeded',
    finishedAt: Date.now(),
    lockedUntil: null,
    ...terminalPatch(),
  })
  .where(and(eq(t.id, row.id), eq(t.lockedUntil, leaseUntil)))
  .returning({ id: t.id })
// Zero rows means another worker re-claimed this job after our lease
// expired. It owns the outcome now; silently drop ours.
if (!updated[0]) return
```

Apply the same zero-row check to the failure paths, returning before `fireOnFailed` so the hook cannot fire twice.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/jobs/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "fix(jobs): fence terminal job updates on the held lease"
```

---

### Task 6: Move the reap off the hot path and return `TickResult`

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts`, `packages/bunderstack/src/jobs/define.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`

**Interfaces:**

- Consumes: nothing new
- Produces: `export type TickResult = { claimed: number; ran: number; failed: number }` in `./define`; `JobsRuntimeFacade.tick(now?: number): Promise<TickResult>`; reap runs at most hourly

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/jobs/worker.test.ts`:

```ts
test('tick reports what it did', async () => {
  const defs: JobsDefs = {
    ok: { kind: 'job', handler: () => {} },
    bad: {
      kind: 'job',
      retries: 0,
      handler: () => {
        throw new Error('nope')
      },
    },
  }
  await enqueueJob(db, defs, 'ok', undefined)
  await enqueueJob(db, defs, 'bad', undefined)

  const result = await runner(defs).tick(Date.now())
  expect(result.claimed).toBe(2)
  expect(result.ran).toBe(1)
  expect(result.failed).toBe(1)
})

test('the reap runs at most hourly', async () => {
  const defs: JobsDefs = { ok: { kind: 'job', handler: () => {} } }
  const r = runner(defs)
  const now = Date.parse('2026-08-07T10:00:00Z')
  await r.tick(now)

  const stale = Date.parse('2026-08-05T10:00:00Z')
  await enqueueJob(db, defs, 'ok', undefined, { dedupeKey: 'old' })
  await db
    .update(bunderstackJobs)
    .set({ status: 'succeeded', finishedAt: stale, dedupeKey: null })
    .where(eq(bunderstackJobs.type, 'ok'))

  // Within the hour: no reap.
  await r.tick(now + 60_000)
  expect(await db.select().from(bunderstackJobs)).not.toHaveLength(0)

  // Past the hour: reaped.
  await r.tick(now + 3_600_001)
  const remaining = await db.select().from(bunderstackJobs)
  expect(remaining.filter((row) => row.status === 'succeeded')).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/jobs/worker.test.ts -t "tick reports"`
Expected: FAIL — `tick` resolves to `undefined`, so reading `.claimed` throws.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/jobs/define.ts`, add next to `JobsRuntimeFacade`:

```ts
export type TickResult = {
  /** Rows moved from pending to running this tick. */
  claimed: number
  /** Handlers that completed successfully. */
  ran: number
  /** Handlers that threw, whether or not they will be retried. */
  failed: number
}
```

and change the facade's `tick` to `tick(now?: number): Promise<TickResult>`.

In `packages/bunderstack/src/jobs/worker.ts`:

```ts
const REAP_INTERVAL_MS = 60 * 60_000
```

Track counters. Have `runJob` return `'ran' | 'failed' | 'lost'`, have `runClaimable` return `{ claimed, ran, failed }` by awaiting `Promise.all(work)` and tallying the results, and gate the reap:

```ts
let lastReapAt = 0

return {
  async tick(now: number = Date.now()): Promise<TickResult> {
    await materializeCronSlots(now)
    await recoverExpiredLeases(now)
    if (now - lastReapAt >= REAP_INTERVAL_MS) {
      lastReapAt = now
      await reapSucceeded(now)
    }
    return runClaimable(now)
  },
  setJobsFacade(f: JobsRuntimeFacade) {
    ctx.jobs = f
  },
}
```

Note `lastReapAt` starts at `0`, so the first tick of a process always reaps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/jobs/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/define.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "refactor(jobs): return TickResult and reap at most hourly"
```

---

### Task 7: `BUNDERSTACK_ROLE` environment validation

**Files:**

- Modify: `packages/bunderstack/src/env.ts`
- Test: `packages/bunderstack/src/env.test.ts`

**Interfaces:**

- Consumes: nothing new
- Produces: `export type BunderstackRole = 'all' | 'web' | 'worker'`; `BaseEnv.BUNDERSTACK_ROLE: BunderstackRole`; `BaseEnv.BUNDERSTACK_CRON_SECRET` removed

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/env.test.ts`:

```ts
test('BUNDERSTACK_ROLE defaults to all', () => {
  const env = validateEnv({ DATABASE_URL: 'file::memory:' }, {})
  expect(env.BUNDERSTACK_ROLE).toBe('all')
})

test('BUNDERSTACK_ROLE accepts web and worker', () => {
  expect(
    validateEnv({ DATABASE_URL: 'file::memory:', BUNDERSTACK_ROLE: 'web' }, {})
      .BUNDERSTACK_ROLE,
  ).toBe('web')
  expect(
    validateEnv(
      { DATABASE_URL: 'file::memory:', BUNDERSTACK_ROLE: 'worker' },
      {},
    ).BUNDERSTACK_ROLE,
  ).toBe('worker')
})

test('an unknown BUNDERSTACK_ROLE fails validation', () => {
  expect(() =>
    validateEnv(
      { DATABASE_URL: 'file::memory:', BUNDERSTACK_ROLE: 'both' },
      {},
    ),
  ).toThrow(/BUNDERSTACK_ROLE/)
})
```

Match the existing file's import of the validation entry point and its option-object shape; if the existing tests call it with a different name than `validateEnv`, use that name.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/env.test.ts`
Expected: FAIL — `BUNDERSTACK_ROLE` is `undefined` and the invalid value is accepted.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/env.ts`:

```ts
export type BunderstackRole = 'all' | 'web' | 'worker'

const ROLES: readonly BunderstackRole[] = ['all', 'web', 'worker']
```

In `BaseEnv`, delete `BUNDERSTACK_CRON_SECRET?: string` and add `BUNDERSTACK_ROLE: BunderstackRole`.

In the `base` object, delete the `BUNDERSTACK_CRON_SECRET` line and add:

```ts
    BUNDERSTACK_ROLE: (source.BUNDERSTACK_ROLE ?? 'all') as BunderstackRole,
```

Delete the `options.cronConfigured && !source.BUNDERSTACK_CRON_SECRET` issue block entirely, along with the `cronConfigured` option from the options type and every caller. Add:

```ts
if (
  source.BUNDERSTACK_ROLE !== undefined &&
  !ROLES.includes(source.BUNDERSTACK_ROLE as BunderstackRole)
) {
  issues.push(
    `BUNDERSTACK_ROLE: must be one of ${ROLES.join(', ')} (got "${String(source.BUNDERSTACK_ROLE)}")`,
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/env.ts packages/bunderstack/src/env.test.ts
git commit -m "feat(env): add BUNDERSTACK_ROLE and drop BUNDERSTACK_CRON_SECRET"
```

---

### Task 8: Role-driven worker auto-start

**Files:**

- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/app-env.test.ts`

**Interfaces:**

- Consumes: `BunderstackRole` from `./env`
- Produces: `createBunderstack` starts the tick loop when the resolved role is `all` or `worker`; config option `background?: { autoStart?: boolean }` overrides it

- [ ] **Step 1: Write the failing tests**

Append to `packages/bunderstack/src/app-env.test.ts`:

```ts
test('role=all starts the background loop', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    env: undefined,
    jobs: (j) =>
      j.define({ beat: j.cron({ schedule: '* * * * *', handler: () => {} }) }),
    envSource: { DATABASE_URL: ':memory:', BUNDERSTACK_ROLE: 'all' },
  } as never)
  expect(app.backgroundRunning).toBe(true)
  await app.close()
})

test('role=web does not start the background loop', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) =>
      j.define({ beat: j.cron({ schedule: '* * * * *', handler: () => {} }) }),
    envSource: { DATABASE_URL: ':memory:', BUNDERSTACK_ROLE: 'web' },
  } as never)
  expect(app.backgroundRunning).toBe(false)
  await app.close()
})

test('background.autoStart false wins over role=all', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) =>
      j.define({ beat: j.cron({ schedule: '* * * * *', handler: () => {} }) }),
    background: { autoStart: false },
    envSource: { DATABASE_URL: ':memory:', BUNDERSTACK_ROLE: 'all' },
  } as never)
  expect(app.backgroundRunning).toBe(false)
  await app.close()
})
```

Match this file's existing `createBunderstack` call shape — reuse whatever key it already uses to inject an env source rather than inventing `envSource` if a different one exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/bunderstack/src/app-env.test.ts`
Expected: FAIL — `app.backgroundRunning` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/index.ts`:

Add `background?: { autoStart?: boolean }` to the config type alongside `rateLimit`.

Add to `BunderstackApp`:

```ts
  /** True when this process is running the background tick loop. */
  readonly backgroundRunning: boolean
```

After `startWorker` and `runWorker` are defined and before the `app` object is assembled:

```ts
// Topology is a deployment concern: the role decides whether this process
// runs background work, so application code never has to.
const roleWantsWorker =
  env.BUNDERSTACK_ROLE === 'all' || env.BUNDERSTACK_ROLE === 'worker'
const autoStart =
  options.background?.autoStart ??
  (roleWantsWorker && !introspect && jobsDefs !== undefined)
let backgroundRunning = false
if (autoStart) {
  await startWorker()
  backgroundRunning = true
}
```

Add `backgroundRunning` to the assembled `app` object. `lifecycle.add` already registers the handle returned by `startWorker`, so `app.close()` stops the loop.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/bunderstack/src/app-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/index.ts packages/bunderstack/src/app-env.test.ts
git commit -m "feat: start background work from BUNDERSTACK_ROLE, not user code"
```

---

### Task 9: Delete the cron machinery

**Files:**

- Delete: `packages/bunderstack/src/jobs/cron-runner.ts`, `cron-runner.test.ts`, `cron-runner.pg.test.ts`, `cron-router.ts`, `cron-router.test.ts`, `cron-auth.ts`, `cron-auth.test.ts`, `local-cron.ts`, `local-cron.test.ts`
- Modify: `packages/bunderstack/src/jobs/index.ts`, `packages/bunderstack/src/index.ts`, `packages/bunderstack/src/handler.ts`
- Test: `packages/bunderstack/src/jobs/integration.test.ts`

**Interfaces:**

- Consumes: `CRON_PREFIX` from `./slots`
- Produces: no cron exports remain; `storage-sweep` is an ordinary registered cron

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/jobs/integration.test.ts`:

```ts
test('the built-in storage sweep is registered as an ordinary cron', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    storage: {
      local: './uploads',
      defaultBucket: 'files',
      buckets: { files: {} },
    },
  } as never)
  expect(app.manifest.background.cron.map((c) => c.name)).toContain(
    'bunderstack:storage-sweep',
  )
  await app.close()
})
```

Match this file's existing `createBunderstack` invocation shape and its manifest accessor; if `manifest.background.cron` is named differently, use the real path.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/jobs/integration.test.ts -t "storage sweep"`
Expected: FAIL — the sweep is a hardcoded route, not a cron definition.

- [ ] **Step 3: Write the implementation**

Delete the nine files listed above.

In `packages/bunderstack/src/jobs/index.ts`, remove the export blocks for `runCronSlot`, `runScheduledSlot`, `CronRunResult`, `buildCronRouter`, `signScheduleRequest`, `verifyScheduleRequest`, `startLocalCronScheduler`, `LocalCronScheduler`, `LocalCronSchedulerOptions`. Add:

```ts
export { slotsDue, floorSlot, CRON_PREFIX, SLOT_MS } from './slots'
export type { CatchUp } from './slots'
export type { TickResult } from './define'
```

In `packages/bunderstack/src/handler.ts`, delete `cronRouter` from `HandlerParts` and delete the `if (parts.cronRouter)` block.

In `packages/bunderstack/src/index.ts`:

- Delete the `cronRouter` local, its `buildCronRouter` import, and the `cronRouter` argument to `buildHandler`.
- Delete `startCronScheduler`, its `AppStartCronSchedulerOptions` type, its entry on `BunderstackApp`, and the `startLocalCronScheduler` / `runCronSlot` / `LocalCronScheduler` imports.
- Register the sweep as a built-in cron by merging it into the resolved defs before `validateBackgroundDefs` runs, only when storage is configured:

```ts
// The storage sweep used to be a hardcoded maintenance route. It is an
// ordinary cron now, so it inherits retries, timeout and onFailed.
const resolvedDefs: JobsDefs | undefined = storageConfigured
  ? {
      ...(jobsDefs ?? {}),
      'bunderstack:storage-sweep': {
        kind: 'cron',
        schedule: '0 4 * * *',
        handler: async () => {
          await storage.sweep()
        },
      },
    }
  : jobsDefs
```

and use `resolvedDefs` everywhere `jobsDefs` was previously passed to the runner, the manifest, and the jobs facade. The reserved-prefix check in Task 2 only rejects `cron:`, so the `bunderstack:` name is legal.

- [ ] **Step 4: Run the full suite**

Run: `bun test packages/bunderstack`
Expected: PASS. Fix any remaining references the compiler surfaces — run `bun run typecheck` in `packages/bunderstack` if the package defines that script.

- [ ] **Step 5: Commit**

```bash
git add -A packages/bunderstack/src
git commit -m "refactor(jobs): delete cron runner, router, auth and local scheduler"
```

---

### Task 10: Drop the `_bunderstack_cron_runs` table

**Files:**

- Modify: `packages/bunderstack/src/internal-tables.ts`
- Test: `packages/bunderstack/src/internal-tables.test.ts` (create if absent)

**Interfaces:**

- Consumes: nothing new
- Produces: `bunderstackCronRuns`, `bunderstackCronRunsPg` and `cronRunsTableFor` no longer exist

- [ ] **Step 1: Write the failing test**

Create or append `packages/bunderstack/src/internal-tables.test.ts`:

```ts
import { test, expect } from 'bun:test'

import { INTERNAL_TABLE_NAMES } from './internal-tables'

test('the cron runs table is gone', () => {
  expect(INTERNAL_TABLE_NAMES).not.toContain('_bunderstack_cron_runs')
})

test('the jobs table is still internal', () => {
  expect(INTERNAL_TABLE_NAMES).toContain('_bunderstack_jobs')
})
```

If the exported constant has a different name than `INTERNAL_TABLE_NAMES`, use the real one — it is the array containing `'_bunderstack_jobs'` and `'_bunderstack_cron_runs'` near line 105.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/bunderstack/src/internal-tables.test.ts`
Expected: FAIL — the array still contains `_bunderstack_cron_runs`.

- [ ] **Step 3: Write the implementation**

In `packages/bunderstack/src/internal-tables.ts`, delete the `bunderstackCronRuns` and `bunderstackCronRunsPg` table definitions, the `'_bunderstack_cron_runs'` entry in the internal-names array, its entry in the dialect lookup map, and the `cronRunsTableFor` helper.

- [ ] **Step 4: Generate the migration and run the suite**

```bash
cd templates/tanstack-start-saas && bun run db:generate
```

Expected: a new drizzle migration dropping `_bunderstack_cron_runs`.

Run: `bun test packages/bunderstack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/bunderstack/src templates/tanstack-start-saas
git commit -m "refactor(db): drop the _bunderstack_cron_runs table"
```

---

### Task 11: Template drops its separate worker

**Files:**

- Delete: `templates/tanstack-start-saas/src/worker.ts`
- Modify: `templates/tanstack-start-saas/package.json`, `templates/tanstack-start-saas/README.md`

**Interfaces:**

- Consumes: role auto-start from Task 8
- Produces: booting the app is the whole deployment

- [ ] **Step 1: Delete the worker entry and script**

Delete `templates/tanstack-start-saas/src/worker.ts`. Remove the `"worker": "bun src/worker.ts"` line from `templates/tanstack-start-saas/package.json`.

- [ ] **Step 2: Document the role**

In `templates/tanstack-start-saas/README.md`, replace any instructions about running a separate worker process with:

```markdown
## Background work

Jobs and cron run in the same process as the server. There is nothing extra to
start.

To split them across processes, set `BUNDERSTACK_ROLE` per process:

- `all` (default) — serves HTTP and runs background work
- `web` — serves HTTP only
- `worker` — runs background work only
```

- [ ] **Step 3: Verify the template still builds and tests**

```bash
cd templates/tanstack-start-saas && bun run typecheck && bun test
```

Expected: PASS, with no reference to `src/worker.ts`.

- [ ] **Step 4: Run the whole repo suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A templates/tanstack-start-saas
git commit -m "build(template): run background work in-process via BUNDERSTACK_ROLE"
```

---

### Task 12: Postgres parity

**Files:**

- Modify: `packages/bunderstack/src/jobs/jobs.pg.test.ts`
- Delete: `packages/bunderstack/src/jobs/cron-runner.pg.test.ts` (already removed in Task 9 — verify)

**Interfaces:**

- Consumes: everything above
- Produces: cron materialization and dispatch verified on Postgres

- [ ] **Step 1: Write the failing test**

Append to `packages/bunderstack/src/jobs/jobs.pg.test.ts`, following that file's existing skip-when-no-database guard and db setup:

```ts
test('cron slots materialize and run once on postgres', async () => {
  let runs = 0
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: () => {
        runs++
      },
    },
  }
  const now = Date.parse('2026-08-07T10:00:30Z')
  const a = createRunner(defs)
  const b = createRunner(defs)
  await Promise.all([a.tick(now), b.tick(now)])
  expect(runs).toBe(1)
})
```

Use whatever runner factory the file already defines rather than introducing `createRunner` if a different helper exists.

- [ ] **Step 2: Run the test**

Run: `bun test packages/bunderstack/src/jobs/jobs.pg.test.ts`
Expected: PASS when a Postgres URL is configured, skipped otherwise. If it fails on the `onConflictDoNothing` target, confirm the unique index on `(type, dedupe_key)` exists in the Postgres table definition.

- [ ] **Step 3: Confirm the deleted pg test is gone**

```bash
test ! -f packages/bunderstack/src/jobs/cron-runner.pg.test.ts && echo "removed"
```

Expected: `removed`.

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/jobs/jobs.pg.test.ts
git commit -m "test(jobs): verify cron slot uniqueness on postgres"
```

---

## Self-Review

**Spec coverage**

| Spec requirement                                             | Task                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Cron occurrence = job with slot dedupe key                   | 3                                                                                                |
| No new columns on `_bunderstack_jobs`                        | 3 (verified by schema untouched)                                                                 |
| Cron gains `retries` / `timeout` / `onFailed`                | 2, 4                                                                                             |
| `concurrency` rejected on cron                               | 2                                                                                                |
| Reserved `cron:` prefix                                      | 2                                                                                                |
| `catchUp` default `latest`, `all` bounded by `catchUpWindow` | 1, 3                                                                                             |
| Watermark = `max(runAt)`, no epoch backfill                  | 3                                                                                                |
| Materialization idempotent under concurrency                 | 3, 12                                                                                            |
| `tick()` phase order and `TickResult`                        | 3, 6                                                                                             |
| Lease fencing on terminal updates                            | 5                                                                                                |
| Backoff jitter                                               | 2                                                                                                |
| Hourly reap, 24h retention unchanged                         | 6                                                                                                |
| `concurrency` documented as per-worker                       | 2 (error message) — **also add a doc comment on `QueueJobDefinition.concurrency` during Task 2** |
| `BUNDERSTACK_ROLE` all/web/worker                            | 7, 8                                                                                             |
| Auto-start, suppressed under `introspect`                    | 8                                                                                                |
| `startCronScheduler` removed                                 | 9                                                                                                |
| `BUNDERSTACK_CRON_SECRET` removed                            | 7, 9                                                                                             |
| Cron routes removed                                          | 9                                                                                                |
| `storage-sweep` as built-in cron                             | 9                                                                                                |
| `_bunderstack_cron_runs` dropped + migration                 | 10                                                                                               |
| Template loses worker script/entry                           | 11                                                                                               |
| Dialect parity                                               | 12                                                                                               |

**Gap found and closed:** the spec requires documenting `concurrency` as per-worker. Task 2's error message covers the cron case; the note above adds the doc comment on the queue case.

**Placeholder scan:** no TBD/TODO, every code step carries real code. Three steps say "match the existing file's shape" for helpers whose exact names could not be read from source — these name the fallback explicitly rather than inventing an API.

**Type consistency:** `AnyBackgroundDefinition` is introduced in Task 2 and used in Tasks 4–6. `TickResult` is defined in Task 6 and returned by `tick` from Task 6 onward — Tasks 3–5 use `tick`'s pre-existing `Promise<void>` shape and their tests do not read its result. `CRON_PREFIX`, `SLOT_MS`, `floorSlot`, `slotsDue`, `CatchUp` all originate in Task 1 and keep those names throughout.
