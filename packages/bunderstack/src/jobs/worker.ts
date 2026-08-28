// src/jobs/worker.ts — the queue worker. One `tick()` is a full cycle:
// recover expired leases → reap old succeeded rows → claim and run queue jobs.
import { and, eq, inArray, is, isNotNull, lt, lte, max, sql } from 'drizzle-orm'
import { PgDatabase } from 'drizzle-orm/pg-core'

import type { AnyDb } from '../dialect'
import type { BunderstackLogger } from '../logging'
import type {
  AnyBackgroundDefinition,
  JobsDefs,
  JobsRuntimeFacade,
  TickResult,
} from './define'

import { jobsTableFor } from '../internal-tables'
import { consoleLogger } from '../logging'
import { validateStandardSchema } from '../standard-schema'
import { parseCron } from './cron'
import { backoffMs, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from './define'
import { enqueueJob } from './queue'
import { CRON_PREFIX, floorSlot, slotsDue, SLOT_MS } from './slots'

const CLAIM_BATCH = 10
const SUCCEEDED_RETENTION_MS = 24 * 60 * 60 * 1000
const REAP_INTERVAL_MS = 60 * 60_000

type JobRow = {
  id: string
  type: string
  payloadJson: string
  attempts: number
  runAt: number
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

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

/** Terminal queue rows release their dedupe key. */
function terminalPatch() {
  return { dedupeKey: null }
}

export function createJobRunner(deps: {
  db: AnyDb
  defs: JobsDefs
  /** Handler ctx WITHOUT `jobs`; the facade is injected via setJobsFacade. */
  ctx: Record<string, unknown>
  logger?: BunderstackLogger
}) {
  const { db, defs } = deps
  const logger = deps.logger ?? consoleLogger
  const t = jobsTableFor(db)
  const ctx = { ...deps.ctx } as Record<string, unknown>
  let lastReapAt = 0

  /** Cron rows carry no payload — their handler input is the slot itself. */
  function resolveInput(def: AnyBackgroundDefinition, row: JobRow): unknown {
    if (def.kind === 'cron') {
      return { scheduledFor: new Date(Number(row.runAt)) }
    }
    const raw = JSON.parse(row.payloadJson)
    return def.input
      ? validateStandardSchema(def.input, raw, 'job payload')
      : undefined
  }

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
      logger.error('[bunderstack] onFailed hook threw:', hookErr)
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
        runAt: t.runAt,
      })
      .from(t)
      .where(
        and(
          eq(t.status, 'running'),
          isNotNull(t.lockedUntil),
          lt(t.lockedUntil, now),
        ),
      )
    for (const row of expired) {
      const def = definitionFor(defs, row.type)
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
            ...terminalPatch(),
          })
          .where(eq(t.id, row.id))
        await fireOnFailed(def, resolveInput(def, row), error)
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
      ? (
          pendingIds as unknown as {
            for: (m: string, o: object) => typeof pendingIds
          }
        ).for('update', { skipLocked: true })
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
        runAt: t.runAt,
      })
    return rows
  }

  // `now` is the tick's injected clock: retry runAt math uses it so tests can
  // drive backoff deterministically. finishedAt uses the real clock (a handler
  // may run long past the tick's start).
  async function runJob(
    row: JobRow,
    def: AnyBackgroundDefinition,
    now: number,
    leaseUntil: number,
  ): Promise<'ran' | 'failed' | 'lost'> {
    let input: unknown
    try {
      input = resolveInput(def, row)
    } catch (err) {
      // Stored payload no longer parses (schema drift): retrying can't help.
      const e = toError(err)
      const updated = await db
        .update(t)
        .set({
          status: 'failed',
          finishedAt: Date.now(),
          lockedUntil: null,
          lastError: e.message,
          ...terminalPatch(),
        })
        .where(and(eq(t.id, row.id), eq(t.lockedUntil, leaseUntil)))
        .returning({ id: t.id })
      if (!updated[0]) return 'lost'
      await fireOnFailed(def, undefined, e)
      return 'failed'
    }
    try {
      await (def.handler as (i: unknown, c: unknown) => unknown)(input, ctx)
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
      if (!updated[0]) return 'lost'
      return 'ran'
    } catch (err) {
      const e = toError(err)
      if (Number(row.attempts) < maxAttempts(def)) {
        const updated = await db
          .update(t)
          .set({
            status: 'pending',
            lockedUntil: null,
            runAt: now + backoffMs(def, Number(row.attempts)),
            lastError: e.message,
          })
          .where(and(eq(t.id, row.id), eq(t.lockedUntil, leaseUntil)))
          .returning({ id: t.id })
        if (!updated[0]) return 'lost'
      } else {
        const updated = await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: Date.now(),
            lockedUntil: null,
            lastError: e.message,
            ...terminalPatch(),
          })
          .where(and(eq(t.id, row.id), eq(t.lockedUntil, leaseUntil)))
          .returning({ id: t.id })
        if (!updated[0]) return 'lost'
        await fireOnFailed(def, input, e)
      }
      return 'failed'
    }
  }

  async function runClaimable(now: number): Promise<TickResult> {
    const claimedWork: Array<{
      row: JobRow
      def: AnyBackgroundDefinition
      leaseUntil: number
    }> = []
    let totalClaimed = 0
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
      totalClaimed += claimed.length
      for (const row of claimed) claimedWork.push({ row, def, leaseUntil })
    }
    // Claim the whole tick snapshot before starting any handler. Work enqueued
    // by a handler therefore belongs to the next tick, regardless of the
    // declaration order of its target job type.
    const outcomes = await Promise.all(
      claimedWork.map(({ row, def, leaseUntil }) =>
        runJob(row, def, now, leaseUntil),
      ),
    )
    let ran = 0
    let failed = 0
    for (const outcome of outcomes) {
      if (outcome === 'ran') ran++
      else if (outcome === 'failed') failed++
    }
    return { claimed: totalClaimed, ran, failed }
  }

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
    async inspect(now: number) {
      const runnableRows = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.status, 'pending'), lte(t.runAt, now)))
      const failed: Array<{
        id: string
        type: string
        attempts: number
        lastError: string | null
      }> = await db
        .select({
          id: t.id,
          type: t.type,
          attempts: t.attempts,
          lastError: t.lastError,
        })
        .from(t)
        .where(eq(t.status, 'failed'))
      const rows: Array<{
        id: string
        type: string
        status: string
        attempts: number
        runAt: number
        dedupeKey: string | null
        lastError: string | null
        createdAt: number
      }> = await db
        .select({
          id: t.id,
          type: t.type,
          status: t.status,
          attempts: t.attempts,
          runAt: t.runAt,
          dedupeKey: t.dedupeKey,
          lastError: t.lastError,
          createdAt: t.createdAt,
        })
        .from(t)
      return {
        runnable: runnableRows.length,
        failed: failed.map((row) => ({
          id: String(row.id),
          name: row.type.startsWith(CRON_PREFIX)
            ? row.type.slice(CRON_PREFIX.length)
            : row.type,
          attempts: Number(row.attempts),
          lastError: row.lastError,
        })),
        jobs: rows
          .sort(
            (left, right) =>
              Number(left.createdAt) - Number(right.createdAt) ||
              String(left.id).localeCompare(String(right.id)),
          )
          .map((row) => ({
            id: String(row.id),
            name: row.type.startsWith(CRON_PREFIX)
              ? row.type.slice(CRON_PREFIX.length)
              : row.type,
            kind: row.type.startsWith(CRON_PREFIX)
              ? ('cron' as const)
              : ('job' as const),
            status: row.status as
              | 'pending'
              | 'running'
              | 'succeeded'
              | 'failed',
            attempts: Number(row.attempts),
            runAt: Number(row.runAt),
            dedupeKey: row.dedupeKey,
            lastError: row.lastError,
          })),
      }
    },
    setJobsFacade(f: JobsRuntimeFacade) {
      ctx.jobs = f
    },
  }
}
