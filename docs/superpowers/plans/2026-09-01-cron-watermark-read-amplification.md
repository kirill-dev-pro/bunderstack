# Cron Watermark Read Amplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop querying and scanning cron job history on every worker cycle while preserving current scheduling, catch-up, retry, and multi-worker behavior.

**Architecture:** Give each job runner a process-local per-cron cursor hydrated once from durable history, advance it only through successfully handled time ranges, and retain cron slot dedupe keys as the durable multi-worker ownership boundary. Add `(type, run_at)` to both internal-table dialects so restart hydration is a one-row index seek.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, SQLite/libSQL, PostgreSQL, `bun:test`

**Spec:** `docs/superpowers/specs/2026-09-01-cron-watermark-read-amplification-design.md`

## Global Constraints

- Keep the application database as the background store.
- Keep the default queue polling interval at exactly `1_000` ms.
- Do not add a public option, environment variable, system table, or Bunderhost change.
- Preserve `catchUp`, `catchUpWindow`, retries, lease fencing, and `scheduledFor` semantics.
- Queue jobs release terminal dedupe keys; cron jobs retain their timestamp dedupe keys.
- SQLite and Postgres internal-table definitions must remain behavioral twins.
- Use Bun commands and `bun:test`.
- Generate and apply consumer migrations; never auto-create an index at runtime.

---

## File Structure

### Modify

- `packages/bunderstack/src/jobs/worker.ts` — own and advance in-memory cron cursors; use indexed newest-row hydration; preserve cron dedupe keys.
- `packages/bunderstack/src/jobs/worker.test.ts` — cover cursor reuse, restart hydration, delayed multi-worker ownership, failure retry, and per-kind dedupe semantics.
- `packages/bunderstack/src/internal-tables.ts` — declare the SQLite `(type, run_at)` index.
- `packages/bunderstack/src/internal-tables-pg.ts` — declare the matching Postgres index.
- `packages/bunderstack/src/internal-tables.test.ts` — assert both dialect definitions expose the new index.
- `packages/bunderstack/CHANGELOG.md` — document the fixed read amplification and migration requirement.
- `CHANGELOG.md` — keep the root changelog mirror synchronized.

No public type file or new runtime module is needed. Cursor ownership belongs in
`createJobRunner()` because its lifecycle must exactly match one worker runtime.

---

### Task 1: Cache cron cursors and preserve slot ownership

**Files:**

- Modify: `packages/bunderstack/src/jobs/worker.ts`
- Modify: `packages/bunderstack/src/jobs/worker.test.ts`
- Test: `packages/bunderstack/src/jobs/worker.test.ts`

**Interfaces:**

- Consumes: existing `runner(defs)`, `cronRows(name)`, `slotsDue()`, `floorSlot()`, `SLOT_MS`, `enqueueJob()`, and `_bunderstack_jobs` test database helpers.
- Produces: a private `Map<string, CronCursor>` scoped to one `createJobRunner()`, kind-aware `terminalPatch(def)`, and regression coverage for both.

- [ ] **Step 1: Update the existing terminal cron assertion**

In `a completed cron slot is not re-materialized on a later tick in the same minute`, replace:

```ts
expect(rows1[0]!.dedupeKey).toBeNull()
```

with:

```ts
expect(rows1[0]!.dedupeKey).toBe(String(Date.parse('2026-08-07T10:00:00Z')))
```

This deliberately fails until Task 2 makes terminal patches depend on the
background definition kind.

- [ ] **Step 2: Add a regression test proving history is read only during hydration**

Place this test after `the watermark advances so a slot is materialized once per minute`:

```ts
test('the worker advances cron scheduling from memory after hydration', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const r = runner(defs)
  const t0 = Date.parse('2026-08-07T10:00:30Z')

  await r.tick(t0)
  await db.delete(bunderstackJobs)

  await r.tick(t0 + 20_000)
  expect(await cronRows('beat')).toHaveLength(0)

  await r.tick(t0 + SLOT_MS)
  const rows = await cronRows('beat')
  expect(rows).toHaveLength(1)
  expect(Number(rows[0]!.runAt)).toBe(
    Date.parse('2026-08-07T10:01:00Z'),
  )
})
```

With the current implementation the second tick sees an empty table and
re-materializes `10:00`, so the `toHaveLength(0)` assertion fails.

- [ ] **Step 3: Add a delayed two-worker regression test**

Place this test after `materialization is idempotent across concurrent ticks`:

```ts
test('a delayed worker cannot duplicate a completed cron slot', async () => {
  let runs = 0
  const defs: JobsDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: () => {
        runs++
      },
    },
  }
  const a = runner(defs)
  const b = runner(defs)
  const before = Date.parse('2026-08-07T09:59:30Z')
  const due = Date.parse('2026-08-07T10:00:00Z')

  await a.tick(before)
  await b.tick(before)
  await a.tick(due)
  await b.tick(due)

  const rows = await cronRows('hourly')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.dedupeKey).toBe(String(due))
  expect(runs).toBe(1)
})
```

This test initializes both process-local cursors before the due slot, then lets
the second worker arrive only after the first handler has completed. It guards
the exact race that terminal cron dedupe retention must close.

- [ ] **Step 4: Extend the failed-cron test with its ownership assertion**

At the end of `a failing cron slot retries with backoff then fires onFailed`, add:

```ts
expect(rows[0]!.dedupeKey).toBe(String(now - (now % SLOT_MS)))
```

- [ ] **Step 5: Run the focused tests and confirm the intended failures**

Run:

```bash
bun test packages/bunderstack/src/jobs/worker.test.ts
```

Expected: the updated terminal-dedupe assertion and the in-memory-cursor test
fail. Existing queue-job dedupe tests must remain green.

- [ ] **Step 6: Replace aggregate hydration with a newest-row lookup**

Change the Drizzle import at the top of `worker.ts` from:

```ts
import { and, eq, inArray, is, isNotNull, lt, lte, max, sql } from 'drizzle-orm'
```

to:

```ts
import {
  and,
  desc,
  eq,
  inArray,
  is,
  isNotNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm'
```

Add beside `PumpResult`:

```ts
type CronCursor = {
  checkedThrough: number
}
```

Add beside `active` inside `createJobRunner()`:

```ts
const cronCursors = new Map<string, CronCursor>()
```

Replace `cronWatermark()` with:

```ts
async function cronCursor(type: string, now: number): Promise<CronCursor> {
  const cached = cronCursors.get(type)
  if (cached) return cached

  const rows = await db
    .select({ runAt: t.runAt })
    .from(t)
    .where(eq(t.type, type))
    .orderBy(desc(t.runAt))
    .limit(1)
  const cursor = {
    checkedThrough:
      rows[0]?.runAt == null
        ? floorSlot(now) - SLOT_MS
        : Number(rows[0].runAt),
  }
  cronCursors.set(type, cursor)
  return cursor
}
```

Do not store a cursor before the query succeeds. A rejected hydration therefore
retries on the next worker cycle.

- [ ] **Step 7: Advance each cursor only through checked or materialized time**

Replace the body of `materializeCronSlots()` with:

```ts
async function materializeCronSlots(now: number) {
  const through = floorSlot(now)
  for (const [name, def] of Object.entries(defs)) {
    if (def.kind !== 'cron') continue
    const type = `${CRON_PREFIX}${name}`
    const cursor = await cronCursor(type, now)
    const slots = slotsDue({
      cron: parseCron(def.schedule),
      from: cursor.checkedThrough,
      to: through,
      catchUp: def.catchUp,
      catchUpWindowMs: def.catchUpWindow,
    })
    for (const slot of slots) {
      await enqueueJob(db, defs, name, null, {
        runAt: slot,
        dedupeKey: String(slot),
      })
      cursor.checkedThrough = slot
    }
    cursor.checkedThrough = Math.max(cursor.checkedThrough, through)
  }
}
```

The assignment after `await enqueueJob()` is intentional: an exception leaves
the cursor at the last successful slot. The final monotonic assignment records
unmatched minutes as checked, prevents repeated in-memory scanning for sparse
cron schedules, and does not regress after a backward clock adjustment.

- [ ] **Step 8: Preserve terminal cron dedupe keys**

Replace the existing parameterless helper:

```ts
function terminalPatch() {
  return { dedupeKey: null }
}
```

with:

```ts
function terminalPatch(def: AnyBackgroundDefinition) {
  return def.kind === 'cron' ? {} : { dedupeKey: null }
}
```

Update all four call sites that have a resolved definition to use:

```ts
...terminalPatch(def)
```

Leave the unknown-definition recovery branch unchanged: it cannot establish
valid cron ownership and should continue clearing its key while failing the
row.

- [ ] **Step 9: Run the focused worker suite**

Run:

```bash
bun test packages/bunderstack/src/jobs/worker.test.ts
```

Expected: PASS. In particular:

- ordinary job dedupe is released and can be reused;
- completed and failed cron slots retain timestamp keys;
- the history-deletion test advances to the next minute without recreating the current one;
- delayed workers execute one slot once.

- [ ] **Step 10: Run formatting and static checks for the modified unit**

```bash
bun run format
bun run lint
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: all clean.

- [ ] **Step 11: Commit the cursor implementation and regressions**

```bash
git add packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts
git commit -m "fix(jobs): cache durable cron watermarks per worker"
```

---

### Task 2: Add the restart-hydration index in both dialects

**Files:**

- Modify: `packages/bunderstack/src/internal-tables.ts`
- Modify: `packages/bunderstack/src/internal-tables-pg.ts`
- Modify: `packages/bunderstack/src/internal-tables.test.ts`
- Test: `packages/bunderstack/src/internal-tables.test.ts`

**Interfaces:**

- Consumes: the `ORDER BY run_at DESC LIMIT 1` hydration query from Task 1.
- Produces: an identically named `bjq_type_run_at` index for SQLite and Postgres schema generation.

- [ ] **Step 1: Add a failing schema-twin test**

Extend the imports in `internal-tables.test.ts`:

```ts
import {
  getTableConfig as getPgTableConfig,
  PgTable,
  pgTable,
  text as pgText,
} from 'drizzle-orm/pg-core'
import {
  getTableConfig as getSqliteTableConfig,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'
```

Add after `jobs table is registered as an internal table in both dialects`:

```ts
test('jobs table indexes newest cron rows by type and runAt in both dialects', () => {
  const sqliteNames = getSqliteTableConfig(bunderstackJobs).indexes.map(
    (entry) => entry.config.name,
  )
  const pgNames = getPgTableConfig(bunderstackJobsPg).indexes.map(
    (entry) => entry.config.name,
  )

  expect(sqliteNames).toContain('bjq_type_run_at')
  expect(pgNames).toContain('bjq_type_run_at')
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test packages/bunderstack/src/internal-tables.test.ts
```

Expected: FAIL because neither dialect declares `bjq_type_run_at`.

- [ ] **Step 3: Declare the index in both table twins**

In both `internal-tables.ts` and `internal-tables-pg.ts`, add this entry between
`bjq_type_status` and `bjq_dedupe`:

```ts
index('bjq_type_run_at').on(t.type, t.runAt),
```

- [ ] **Step 4: Verify the table contract**

```bash
bun test packages/bunderstack/src/internal-tables.test.ts
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: both commands pass.

- [ ] **Step 5: Commit the schema change**

```bash
git add packages/bunderstack/src/internal-tables.ts packages/bunderstack/src/internal-tables-pg.ts packages/bunderstack/src/internal-tables.test.ts
git commit -m "fix(jobs): index cron watermark hydration"
```

---

### Task 3: Document the fix and consumer migration

**Files:**

- Modify: `packages/bunderstack/CHANGELOG.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: the runtime and schema behavior implemented in Tasks 1 and 2.
- Produces: release guidance telling applications with committed migrations how to receive the performance fix.

- [ ] **Step 1: Add the same unreleased entry to both changelogs**

Insert immediately below each `# Changelog` introduction:

```md
## Unreleased

### Fixed

- **Cron scheduler read amplification.** Background workers hydrate each cron
  watermark once per process and advance it in memory instead of aggregating
  `_bunderstack_jobs` every polling cycle. Cron slots retain their dedupe key
  through terminal status so delayed workers cannot recreate a completed slot.
  The jobs table adds the `bjq_type_run_at` index; applications with committed
  migrations must run their existing `db:generate` command and apply the
  generated migration after upgrading.

```

- [ ] **Step 2: Verify both entries are byte-identical**

Run:

```bash
diff -u CHANGELOG.md packages/bunderstack/CHANGELOG.md
```

Expected: no output and exit code 0. The repository currently keeps these files
as mirrors.

- [ ] **Step 3: Commit the release guidance**

```bash
git add CHANGELOG.md packages/bunderstack/CHANGELOG.md
git commit -m "docs: explain cron watermark migration"
```

---

### Task 4: Run full regression and packaging verification

**Files:**

- Verify only; no planned source changes.

**Interfaces:**

- Consumes: all previous tasks.
- Produces: evidence that the internal scheduler change is safe to release and consumable from built package artifacts.

- [ ] **Step 1: Run the complete jobs test surface**

```bash
bun test packages/bunderstack/src/jobs
```

Expected: all queue, cron, slot, worker, runtime, SQLite integration, and
conditional Postgres jobs tests pass.

- [ ] **Step 2: Run the package test and typecheck**

```bash
bun run --cwd packages/bunderstack test
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: both pass.

- [ ] **Step 3: Run repository formatting, linting, and full tests**

```bash
bun run format
bun run lint
bun run typecheck
bun test
```

Expected: all clean. If formatting changes a planned file, inspect and include
only those mechanical edits in the relevant preceding commit rather than
creating an unrelated formatting commit.

- [ ] **Step 4: Verify built consumer artifacts**

```bash
bun run build
bun run verify:consumer
```

Expected: package build and strict throwaway-consumer verification pass.

- [ ] **Step 5: Inspect the final diff against the approved scope**

```bash
git diff HEAD~4 -- packages/bunderstack/src/jobs/worker.ts packages/bunderstack/src/jobs/worker.test.ts packages/bunderstack/src/internal-tables.ts packages/bunderstack/src/internal-tables-pg.ts packages/bunderstack/src/internal-tables.test.ts CHANGELOG.md packages/bunderstack/CHANGELOG.md
```

Expected: only cursor hydration/advancement, per-kind terminal dedupe behavior,
the twin index, their tests, and migration guidance. There must be no polling,
public API, new-table, Bunderhost, or database-backend change.

---

## Follow-up outside this plan

After publishing the Bunderstack release, upgrade HR Breakers, run its existing
`bun run db:generate`, inspect that the generated migration only creates
`bjq_type_run_at`, apply it, deploy, and compare Turso Top Queries over the same
six-hour window. That application rollout is deliberately separate from the
library fix so each change has an independent review and rollback boundary.
