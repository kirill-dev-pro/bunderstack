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
import { backoffMs, DEFAULT_RETRIES, leaseDurationFor } from './define'
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

type LeaseOwner = {
  attempt: number
  lockedUntil: number
}

type ClaimedWork = {
  row: JobRow
  def: AnyBackgroundDefinition
  owner: LeaseOwner
}

type LeaseHeartbeat = {
  owner: LeaseOwner
  lost: Promise<void>
  stop(): Promise<void>
}

type PumpResult = { wake?: Promise<void> }

function capacityFor(def: AnyBackgroundDefinition): number {
  return def.kind === 'job' && def.concurrency !== undefined
    ? def.concurrency
    : CLAIM_BATCH
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
  const active = new Map<string, Set<Promise<void>>>()

  function ownershipPredicate(id: string, owner: LeaseOwner) {
    return and(
      eq(t.id, id),
      eq(t.status, 'running'),
      eq(t.attempts, owner.attempt),
      eq(t.lockedUntil, owner.lockedUntil),
    )
  }

  function startLeaseHeartbeat(args: {
    row: JobRow
    def: AnyBackgroundDefinition
    owner: LeaseOwner
    onLost: () => void
  }): LeaseHeartbeat {
    const owner = args.owner
    const intervalMs = Math.max(10, Math.floor(leaseDurationFor(args.def) / 3))
    let stopped = false
    let resolveLost!: () => void
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve
    })
    let chain = Promise.resolve()
    const lose = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      resolveLost()
      args.onLost()
    }
    const renew = () => {
      chain = chain
        .then(async () => {
          if (stopped) return
          const nextLockedUntil = Date.now() + leaseDurationFor(args.def)
          const updated = await db
            .update(t)
            .set({ lockedUntil: nextLockedUntil })
            .where(ownershipPredicate(args.row.id, owner))
            .returning({ id: t.id })
          if (!updated[0]) return lose()
          owner.lockedUntil = nextLockedUntil
        })
        .catch(() => lose())
    }
    const timer = setInterval(renew, intervalMs)
    return {
      owner,
      lost,
      async stop() {
        stopped = true
        clearInterval(timer)
        await chain
      },
    }
  }

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
    const expired: (JobRow & {
      lastError: string | null
      lockedUntil: number
    })[] = await db
      .select({
        id: t.id,
        type: t.type,
        payloadJson: t.payloadJson,
        attempts: t.attempts,
        lastError: t.lastError,
        runAt: t.runAt,
        lockedUntil: t.lockedUntil,
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
      const owner = {
        attempt: Number(row.attempts),
        lockedUntil: Number(row.lockedUntil),
      }
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
          .where(ownershipPredicate(row.id, owner))
        continue
      }
      if (Number(row.attempts) >= maxAttempts(def)) {
        const updated = await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: now,
            lockedUntil: null,
            lastError: error.message,
            ...terminalPatch(),
          })
          .where(ownershipPredicate(row.id, owner))
          .returning({ id: t.id })
        if (updated[0]) await fireOnFailed(def, resolveInput(def, row), error)
      } else {
        await db
          .update(t)
          .set({
            status: 'pending',
            lockedUntil: null,
            runAt: now + backoffMs(def, Number(row.attempts)),
            lastError: error.message,
          })
          .where(ownershipPredicate(row.id, owner))
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

  async function claimAvailable(
    type: string,
    def: AnyBackgroundDefinition,
    now: number,
  ): Promise<ClaimedWork[]> {
    const runningRows = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.type, type), eq(t.status, 'running')))
    let available = capacityFor(def) - runningRows.length
    if (available <= 0) return []

    const leaseUntil = now + leaseDurationFor(def)
    const work: ClaimedWork[] = []
    while (available > 0) {
      const limit = Math.min(CLAIM_BATCH, available)
      const rows = await claim(type, limit, now, leaseUntil)
      for (const row of rows) {
        work.push({
          row,
          def,
          owner: { attempt: Number(row.attempts), lockedUntil: leaseUntil },
        })
      }
      available -= rows.length
      if (rows.length < limit) break
    }
    return work
  }

  // `now` is the tick's injected clock: retry runAt math uses it so tests can
  // drive backoff deterministically. finishedAt uses the real clock (a handler
  // may run long past the tick's start).
  async function runJob(
    row: JobRow,
    def: AnyBackgroundDefinition,
    now: number,
    owner: LeaseOwner,
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
        .where(ownershipPredicate(row.id, owner))
        .returning({ id: t.id })
      if (!updated[0]) return 'lost'
      await fireOnFailed(def, undefined, e)
      return 'failed'
    }
    let lost = false
    const heartbeat = startLeaseHeartbeat({
      row,
      def,
      owner,
      onLost: () => {
        lost = true
      },
    })
    try {
      await (def.handler as (i: unknown, c: unknown) => unknown)(input, ctx)
      await heartbeat.stop()
      if (lost) return 'lost'
      const updated = await db
        .update(t)
        .set({
          status: 'succeeded',
          finishedAt: Date.now(),
          lockedUntil: null,
          ...terminalPatch(),
        })
        .where(ownershipPredicate(row.id, owner))
        .returning({ id: t.id })
      if (!updated[0]) return 'lost'
      return 'ran'
    } catch (err) {
      const e = toError(err)
      await heartbeat.stop()
      if (lost) return 'lost'
      if (Number(row.attempts) < maxAttempts(def)) {
        const updated = await db
          .update(t)
          .set({
            status: 'pending',
            lockedUntil: null,
            runAt: now + backoffMs(def, Number(row.attempts)),
            lastError: e.message,
          })
          .where(ownershipPredicate(row.id, owner))
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
          .where(ownershipPredicate(row.id, owner))
          .returning({ id: t.id })
        if (!updated[0]) return 'lost'
        await fireOnFailed(def, input, e)
      }
      return 'failed'
    }
  }

  async function runClaimable(now: number): Promise<TickResult> {
    const claimedWork: ClaimedWork[] = []
    let totalClaimed = 0
    for (const [name, def] of Object.entries(defs)) {
      const type = def.kind === 'cron' ? `${CRON_PREFIX}${name}` : name
      const claimed = await claimAvailable(type, def, now)
      totalClaimed += claimed.length
      claimedWork.push(...claimed)
    }
    // Claim the whole tick snapshot before starting any handler. Work enqueued
    // by a handler therefore belongs to the next tick, regardless of the
    // declaration order of its target job type.
    const outcomes = await Promise.all(
      claimedWork.map(({ row, def, owner }) =>
        runJob(row, def, now, owner),
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

  async function maintain(now: number) {
    await materializeCronSlots(now)
    await recoverExpiredLeases(now)
    if (now - lastReapAt >= REAP_INTERVAL_MS) {
      lastReapAt = now
      await reapSucceeded(now)
    }
  }

  function startWork(
    type: string,
    work: ClaimedWork,
    claimedAt: number,
  ): Promise<void> {
    let tasks = active.get(type)
    if (!tasks) {
      tasks = new Set()
      active.set(type, tasks)
    }
    let task: Promise<void>
    task = runJob(work.row, work.def, claimedAt, work.owner)
      .then(() => undefined)
      .catch((error) => {
        logger.error('[bunderstack] background job execution failed:', error)
      })
      .finally(() => {
        tasks!.delete(task)
        if (tasks!.size === 0) active.delete(type)
      })
    tasks.add(task)
    return task
  }

  async function pump(now: number = Date.now()): Promise<PumpResult> {
    await maintain(now)
    for (const [name, def] of Object.entries(defs)) {
      const type = def.kind === 'cron' ? `${CRON_PREFIX}${name}` : name
      const work = await claimAvailable(type, def, now)
      for (const item of work) startWork(type, item, now)
    }
    const snapshot = [...active.values()].flatMap((tasks) => [...tasks])
    return snapshot.length === 0
      ? {}
      : { wake: Promise.race(snapshot).then(() => undefined) }
  }

  async function drain(): Promise<void> {
    const snapshot = [...active.values()].flatMap((tasks) => [...tasks])
    await Promise.allSettled(snapshot)
  }

  return {
    async tick(now: number = Date.now()): Promise<TickResult> {
      await maintain(now)
      return runClaimable(now)
    },
    pump,
    drain,
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
