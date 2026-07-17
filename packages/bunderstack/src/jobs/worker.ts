// src/jobs/worker.ts — the in-process worker. One `tick()` is a full cycle:
// recover expired leases → schedule cron slots → reap old succeeded rows →
// claim and run claimable jobs (awaiting handlers, so tests drive `tick()`
// deterministically with an injected `now`). Multiple replicas run the same
// loop safely: claims are atomic and cron slots dedupe on a unique index.
import { and, eq, inArray, is, isNotNull, lt, lte, sql } from 'drizzle-orm'
import { PgDatabase } from 'drizzle-orm/pg-core'

import type { AnyDb } from '../dialect'
import type {
  AnyJobDefinition,
  JobsDefs,
  JobsRuntimeFacade,
} from './define'
import type { ParsedCron } from './cron'

import { jobsTableFor } from '../internal-tables'
import { cronMatches, parseCron } from './cron'
import { backoffMs, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from './define'
import { enqueueJob } from './queue'

const CLAIM_BATCH = 10
const SUCCEEDED_RETENTION_MS = 24 * 60 * 60 * 1000

type JobRow = {
  id: string
  type: string
  payloadJson: string
  attempts: number
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function maxAttempts(def: AnyJobDefinition): number {
  return 1 + (def.retries ?? DEFAULT_RETRIES)
}

/** Terminal-status column patch: non-cron jobs release their dedupe key. */
function terminalPatch(def: AnyJobDefinition | undefined) {
  return def?.cron ? {} : { dedupeKey: null }
}

export function createJobRunner(deps: {
  db: AnyDb
  defs: JobsDefs
  /** Handler ctx WITHOUT `jobs`; the facade is injected via setJobsFacade. */
  ctx: Record<string, unknown>
}) {
  const { db, defs } = deps
  const t = jobsTableFor(db)
  const ctx = { ...deps.ctx } as Record<string, unknown>
  const crons = new Map<string, ParsedCron>()
  for (const [name, def] of Object.entries(defs)) {
    if (def.cron) crons.set(name, parseCron(def.cron))
  }

  async function fireOnFailed(
    def: AnyJobDefinition,
    payloadJson: string,
    error: Error,
  ) {
    if (!def.onFailed) return
    let input: unknown
    try {
      const raw = JSON.parse(payloadJson)
      input = def.input ? def.input.parse(raw) : undefined
    } catch {
      input = undefined // payload unusable; the hook still gets the error
    }
    try {
      await def.onFailed(input, error, ctx as never)
    } catch (hookErr) {
      console.error('[bunderstack] onFailed hook threw:', hookErr)
    }
  }

  /** running rows whose lease expired → pending (or failed when exhausted). */
  async function recoverExpiredLeases(now: number) {
    const expired: (JobRow & { lastError: string | null })[] = await db
      .select({
        id: t.id,
        type: t.type,
        payloadJson: t.payloadJson,
        attempts: t.attempts,
        lastError: t.lastError,
      })
      .from(t)
      .where(
        and(eq(t.status, 'running'), isNotNull(t.lockedUntil), lt(t.lockedUntil, now)),
      )
    for (const row of expired) {
      const def = defs[row.type]
      const error = new Error('lease expired (worker crashed or timed out)')
      if (!def) {
        await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: now,
            lockedUntil: null,
            lastError: `unknown job type "${row.type}"`,
            dedupeKey: null,
          })
          .where(eq(t.id, row.id))
        continue
      }
      if (Number(row.attempts) >= maxAttempts(def)) {
        await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: now,
            lockedUntil: null,
            lastError: error.message,
            ...terminalPatch(def),
          })
          .where(eq(t.id, row.id))
        await fireOnFailed(def, row.payloadJson, error)
      } else {
        await db
          .update(t)
          .set({
            status: 'pending',
            lockedUntil: null,
            runAt: now + backoffMs(def, Number(row.attempts)),
            lastError: error.message,
          })
          .where(eq(t.id, row.id))
      }
    }
  }

  /** Enqueue the current minute's slot for every cron definition. */
  async function scheduleCronSlots(now: number) {
    const minute = Math.floor(now / 60_000) * 60_000
    for (const [name, cron] of crons) {
      if (!cronMatches(cron, minute)) continue
      // The unique (type, dedupe_key) index collapses concurrent replicas'
      // enqueues of the same slot into one row.
      await enqueueJob(db, defs, name, undefined, {
        dedupeKey: `cron:${name}:${minute}`,
        runAt: minute,
      })
    }
  }

  async function reapSucceeded(now: number) {
    await db
      .delete(t)
      .where(
        and(
          eq(t.status, 'succeeded'),
          lt(t.finishedAt, now - SUCCEEDED_RETENTION_MS),
        ),
      )
  }

  /** Atomically claim up to `limit` runnable jobs of one type. */
  async function claim(
    type: string,
    limit: number,
    now: number,
    leaseUntil: number,
  ): Promise<JobRow[]> {
    const pendingIds = db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.type, type), eq(t.status, 'pending'), lte(t.runAt, now)))
      .orderBy(t.runAt)
      .limit(limit)
    // PG: lock the selected rows so concurrent replicas skip them. SQLite's
    // single-writer model makes the one-statement UPDATE atomic on its own.
    const sub = is(db, PgDatabase)
      ? (pendingIds as unknown as { for: (m: string, o: object) => typeof pendingIds })
          .for('update', { skipLocked: true })
      : pendingIds
    const rows: JobRow[] = await db
      .update(t)
      .set({
        status: 'running',
        lockedUntil: leaseUntil,
        attempts: sql`${t.attempts} + 1`,
      })
      .where(and(inArray(t.id, sub), eq(t.status, 'pending')))
      .returning({
        id: t.id,
        type: t.type,
        payloadJson: t.payloadJson,
        attempts: t.attempts,
      })
    return rows
  }

  // `now` is the tick's injected clock: retry runAt math uses it so tests can
  // drive backoff deterministically. finishedAt uses the real clock (a handler
  // may run long past the tick's start).
  async function runJob(row: JobRow, def: AnyJobDefinition, now: number) {
    let input: unknown
    try {
      const raw = JSON.parse(row.payloadJson)
      input = def.input ? def.input.parse(raw) : undefined
    } catch (err) {
      // Stored payload no longer parses (schema drift): retrying can't help.
      const e = toError(err)
      await db
        .update(t)
        .set({
          status: 'failed',
          finishedAt: Date.now(),
          lockedUntil: null,
          lastError: e.message,
          ...terminalPatch(def),
        })
        .where(eq(t.id, row.id))
      await fireOnFailed(def, row.payloadJson, e)
      return
    }
    try {
      await def.handler(input, ctx as never)
      await db
        .update(t)
        .set({
          status: 'succeeded',
          finishedAt: Date.now(),
          lockedUntil: null,
          ...terminalPatch(def),
        })
        .where(eq(t.id, row.id))
    } catch (err) {
      const e = toError(err)
      if (Number(row.attempts) < maxAttempts(def)) {
        await db
          .update(t)
          .set({
            status: 'pending',
            lockedUntil: null,
            runAt: now + backoffMs(def, Number(row.attempts)),
            lastError: e.message,
          })
          .where(eq(t.id, row.id))
      } else {
        await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: Date.now(),
            lockedUntil: null,
            lastError: e.message,
            ...terminalPatch(def),
          })
          .where(eq(t.id, row.id))
        await fireOnFailed(def, row.payloadJson, e)
      }
    }
  }

  async function runClaimable(now: number) {
    const work: Promise<void>[] = []
    for (const [type, def] of Object.entries(defs)) {
      let limit = CLAIM_BATCH
      if (def.concurrency !== undefined) {
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

  return {
    async tick(now: number = Date.now()) {
      await recoverExpiredLeases(now)
      await scheduleCronSlots(now)
      await reapSucceeded(now)
      await runClaimable(now)
    },
    setJobsFacade(f: JobsRuntimeFacade) {
      ctx.jobs = f
    },
  }
}
