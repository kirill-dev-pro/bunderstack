// src/jobs/worker.ts — the queue worker. One `tick()` is a full cycle:
// recover expired leases → reap stale rows → claim and run queue jobs.
//
// The table holds work, not history. A queue job's row is deleted the moment
// it succeeds, a cron owns one row that moves from slot to slot, and what a
// finished attempt was goes to the logger and to telemetry as a JobRunEvent.
import {
  and,
  desc,
  eq,
  inArray,
  is,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { PgDatabase } from 'drizzle-orm/pg-core'

import type { AnyDb } from '../dialect'
import type { BunderstackLogger } from '../logging'
import type { JobRunEvent, TelemetrySink } from '../telemetry/telemetry'
import type {
  AnyBackgroundDefinition,
  JobsDefs,
  JobsRuntimeFacade,
  TickResult,
} from './define'

import { jobsTableFor } from '../internal-tables'
import { consoleLogger } from '../logging'
import { validateStandardSchema } from '../standard-schema'
import { noopTelemetry } from '../telemetry/telemetry'
import { generate } from '../typeid'
import { parseCron } from './cron'
import { backoffMs, DEFAULT_RETRIES, leaseDurationFor } from './define'
import {
  CRON_PREFIX,
  CRON_SLOT_KEY,
  floorSlot,
  slotsDue,
  SLOT_MS,
} from './slots'

const CLAIM_BATCH = 10
const DAY_MS = 24 * 60 * 60 * 1000
/** Failed rows are kept so they can be inspected and retried, but not
 *  forever: each one carries its full payload and error. */
const FAILED_RETENTION_MS = 30 * DAY_MS
const REAP_INTERVAL_MS = 60 * 60_000
const REAP_BATCH = 1000

class JobExecutionTimeoutError extends Error {
  constructor(maxRuntime: number) {
    super(`execution timed out after ${maxRuntime}ms`)
    this.name = 'JobExecutionTimeoutError'
  }
}

class JobLeaseLostError extends Error {
  constructor() {
    super('job lease ownership was lost')
    this.name = 'JobLeaseLostError'
  }
}

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

type CronCursor = {
  checkedThrough: number
}

function jobEvent(
  event: string,
  row: JobRow,
  fields: Record<string, unknown> = {},
) {
  return {
    source: 'bunderstack.jobs',
    event,
    jobId: row.id,
    jobType: row.type,
    attempt: Number(row.attempts),
    ...fields,
  }
}

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

/** Queue jobs release terminal dedupe keys; cron slots retain durable ownership. */
function terminalPatch(def: AnyBackgroundDefinition) {
  return def.kind === 'cron' ? {} : { dedupeKey: null }
}

/**
 * Sends an attempt back to pending to run again after its backoff. A queue
 * job moves its `runAt`; a cron keeps `runAt` on the slot it is running for
 * (that is its identity and its handler's input) and waits out the backoff
 * in `lockedUntil`, which the claim reads as "not before" on a pending row.
 */
function retryPatch(
  def: AnyBackgroundDefinition,
  row: JobRow,
  now: number,
  error: Error,
) {
  const notBefore = now + backoffMs(def, Number(row.attempts))
  return def.kind === 'cron'
    ? { status: 'pending', lockedUntil: notBefore, lastError: error.message }
    : {
        status: 'pending',
        lockedUntil: null,
        runAt: notBefore,
        lastError: error.message,
      }
}

/** `dedupeUntil: 'start'` releases the key at claim; everything else keeps it
 *  until a terminal state, so the claim patch stays unchanged for them. */
function claimPatch(def: AnyBackgroundDefinition) {
  return def.kind === 'job' && def.dedupeUntil === 'start'
    ? { dedupeKey: null }
    : {}
}

export function createJobRunner(deps: {
  db: AnyDb
  defs: JobsDefs
  /** Handler ctx WITHOUT `jobs`; the facade is injected via setJobsFacade. */
  ctx: Record<string, unknown>
  logger?: BunderstackLogger
  /** Durations and failures of every run; absent means not reported. */
  telemetry?: TelemetrySink
}) {
  const { db, defs } = deps
  const logger = deps.logger ?? consoleLogger
  const telemetry = deps.telemetry ?? noopTelemetry
  const jobKind = (def: AnyBackgroundDefinition): 'job' | 'cron' =>
    def.kind === 'cron' ? 'cron' : 'job'
  const t = jobsTableFor(db)
  const ctx = { ...deps.ctx } as Record<string, unknown>
  let lastReapAt = 0
  const active = new Map<string, Set<Promise<void>>>()
  const cronCursors = new Map<string, CronCursor>()

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

  /** Hydrate each cron cursor once, then advance it in this worker's memory. */
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

  /**
   * Moves a cron's one row onto `slot`: inserted on first sight, afterwards
   * advanced once it rests (`succeeded` or `failed`) on an earlier slot. The
   * unique (type, dedupeKey) index makes this safe for any number of workers:
   * exactly one insert or update wins, and the rest read the row back.
   *
   * `busy` means the row still holds an earlier slot that is pending or
   * running; the caller leaves its cursor and asks again next tick.
   */
  async function takeCronSlot(
    type: string,
    slot: number,
    now: number,
  ): Promise<'taken' | 'busy'> {
    const inserted = await db
      .insert(t)
      .values({
        id: generate('job'),
        type,
        payloadJson: 'null',
        status: 'pending',
        attempts: 0,
        runAt: slot,
        dedupeKey: CRON_SLOT_KEY,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [t.type, t.dedupeKey] })
      .returning({ id: t.id })
    if (inserted[0]) return 'taken'
    const advanced = await db
      .update(t)
      .set({
        status: 'pending',
        attempts: 0,
        runAt: slot,
        lockedUntil: null,
        lastError: null,
        finishedAt: null,
        createdAt: now,
      })
      .where(
        and(
          eq(t.type, type),
          eq(t.dedupeKey, CRON_SLOT_KEY),
          inArray(t.status, ['succeeded', 'failed']),
          lt(t.runAt, slot),
        ),
      )
      .returning({ id: t.id })
    if (advanced[0]) return 'taken'
    const current = await db
      .select({ runAt: t.runAt })
      .from(t)
      .where(and(eq(t.type, type), eq(t.dedupeKey, CRON_SLOT_KEY)))
      .limit(1)
    return current[0] && Number(current[0].runAt) >= slot ? 'taken' : 'busy'
  }

  /** Puts each cron's row on its next due slot. Slots run one at a time per
   *  schedule — the row is taken for the next one once the current rests —
   *  so `catchUp: 'all'` works through missed slots over successive ticks. */
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
      if (slots.length === 0) {
        cursor.checkedThrough = Math.max(cursor.checkedThrough, through)
        continue
      }
      const slot = slots[0]!
      if ((await takeCronSlot(type, slot, now)) === 'busy') continue
      // Taken by this worker or seen taken by another: the slot is covered.
      // With nothing else due, so is everything up to `through`.
      cursor.checkedThrough =
        slots.length === 1 ? Math.max(slot, through) : slot
    }
  }

  function runRecord(
    row: JobRow,
    def: AnyBackgroundDefinition,
    outcome: JobRunEvent['outcome'],
    durationMs: number,
    error?: Error,
  ): JobRunEvent {
    return {
      type: row.type,
      kind: jobKind(def),
      outcome,
      jobId: row.id,
      attempt: Number(row.attempts),
      runAt: new Date(Number(row.runAt)).toISOString(),
      finishedAt: new Date(Date.now()).toISOString(),
      durationMs,
      ...(error ? { error: error.message } : {}),
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
      // The attempt held its lease to the end; that is the closest the
      // record can come to how long it ran.
      const heldMs = leaseDurationFor(def)
      if (Number(row.attempts) >= maxAttempts(def)) {
        const updated = await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: now,
            lockedUntil: null,
            lastError: error.message,
            ...terminalPatch(def),
          })
          .where(ownershipPredicate(row.id, owner))
          .returning({ id: t.id })
        if (updated[0]) {
          telemetry.recordJobRun(runRecord(row, def, 'failed', heldMs, error))
          await fireOnFailed(def, resolveInput(def, row), error)
        }
      } else {
        const updated = await db
          .update(t)
          .set(retryPatch(def, row, now, error))
          .where(ownershipPredicate(row.id, owner))
          .returning({ id: t.id })
        if (updated[0])
          telemetry.recordJobRun(runRecord(row, def, 'retrying', heldMs, error))
      }
    }
  }

  /**
   * Deletes stale rows in batches, so a backlog (the first sweep after an
   * upgrade, a burst of failures) never holds the write lock for one long
   * statement. Failed rows go after their retention. Succeeded rows are left
   * only by releases before 0.29 — a success deletes its row now — and go at
   * once, except a cron's slot row, which rests as `succeeded` between
   * occurrences and is told apart by its key.
   */
  async function reapFinished(now: number) {
    const stale = [
      and(eq(t.status, 'failed'), lt(t.finishedAt, now - FAILED_RETENTION_MS)),
      and(
        eq(t.status, 'succeeded'),
        or(isNull(t.dedupeKey), ne(t.dedupeKey, CRON_SLOT_KEY)),
      ),
    ]
    for (const where of stale) {
      for (;;) {
        const batch = db
          .select({ id: t.id })
          .from(t)
          .where(where)
          .limit(REAP_BATCH)
        const deleted = await db
          .delete(t)
          .where(inArray(t.id, batch))
          .returning({ id: t.id })
        if (deleted.length < REAP_BATCH) break
      }
    }
  }

  /** Atomically claim up to `limit` runnable jobs of one type. */
  async function claim(
    type: string,
    def: AnyBackgroundDefinition,
    limit: number,
    now: number,
    leaseUntil: number,
  ): Promise<JobRow[]> {
    const pendingIds = db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.type, type),
          eq(t.status, 'pending'),
          lte(t.runAt, now),
          // A retrying cron waits out its backoff here (see retryPatch).
          or(isNull(t.lockedUntil), lte(t.lockedUntil, now)),
        ),
      )
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
        ...claimPatch(def),
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
      const rows = await claim(type, def, limit, now, leaseUntil)
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
    const startedAt = Date.now()
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
          ...terminalPatch(def),
        })
        .where(ownershipPredicate(row.id, owner))
        .returning({ id: t.id })
      if (!updated[0]) return 'lost'
      telemetry.recordJobRun(
        runRecord(row, def, 'failed', Date.now() - startedAt, e),
      )
      await fireOnFailed(def, undefined, e)
      return 'failed'
    }
    const controller = new AbortController()
    const handlerCtx = { ...ctx, signal: controller.signal }
    logger.info(JSON.stringify(jobEvent('job.claimed', row)))
    let lost = false
    const heartbeat = startLeaseHeartbeat({
      row,
      def,
      owner,
      onLost: () => {
        lost = true
        controller.abort(new JobLeaseLostError())
        logger.warn(
          JSON.stringify(
            jobEvent('job.lease_lost', row, {
              durationMs: Date.now() - startedAt,
            }),
          ),
        )
      },
    })
    const deadline =
      def.maxRuntime === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(new JobExecutionTimeoutError(def.maxRuntime!))
            logger.warn(
              JSON.stringify(
                jobEvent('job.execution_timed_out', row, {
                  durationMs: Date.now() - startedAt,
                }),
              ),
            )
          }, def.maxRuntime)
    try {
      await (def.handler as (i: unknown, c: unknown) => unknown)(
        input,
        handlerCtx,
      )
      if (controller.signal.reason instanceof JobExecutionTimeoutError) {
        throw controller.signal.reason
      }
      if (deadline) clearTimeout(deadline)
      await heartbeat.stop()
      if (lost) return 'lost'
      // A finished queue job leaves no row: the log line and the run record
      // below are what remains of it. A cron's row rests as `succeeded` on
      // this slot until the next one advances it.
      const finished =
        def.kind === 'cron'
          ? await db
              .update(t)
              .set({
                status: 'succeeded',
                finishedAt: Date.now(),
                lockedUntil: null,
              })
              .where(ownershipPredicate(row.id, owner))
              .returning({ id: t.id })
          : await db
              .delete(t)
              .where(ownershipPredicate(row.id, owner))
              .returning({ id: t.id })
      if (!finished[0]) return 'lost'
      const durationMs = Date.now() - startedAt
      logger.info(
        JSON.stringify(jobEvent('job.completed', row, { durationMs })),
      )
      telemetry.recordJob({
        type: row.type,
        kind: jobKind(def),
        outcome: 'succeeded',
        durationMs,
      })
      telemetry.recordJobRun(runRecord(row, def, 'succeeded', durationMs))
      return 'ran'
    } catch (err) {
      if (deadline) clearTimeout(deadline)
      const e =
        controller.signal.reason instanceof JobExecutionTimeoutError
          ? controller.signal.reason
          : toError(err)
      await heartbeat.stop()
      if (lost) return 'lost'
      if (Number(row.attempts) < maxAttempts(def)) {
        const updated = await db
          .update(t)
          .set(retryPatch(def, row, now, e))
          .where(ownershipPredicate(row.id, owner))
          .returning({ id: t.id })
        if (!updated[0]) return 'lost'
        logger.warn(
          JSON.stringify(
            jobEvent('job.retrying', row, {
              durationMs: Date.now() - startedAt,
              error: e.message,
            }),
          ),
        )
        telemetry.recordJob({
          type: row.type,
          kind: jobKind(def),
          outcome: 'retrying',
          durationMs: Date.now() - startedAt,
        })
        telemetry.recordJobRun(
          runRecord(row, def, 'retrying', Date.now() - startedAt, e),
        )
        telemetry.captureException(e, {
          source: jobKind(def),
          jobType: row.type,
          jobId: row.id,
          attempt: Number(row.attempts),
          willRetry: true,
        })
      } else {
        const updated = await db
          .update(t)
          .set({
            status: 'failed',
            finishedAt: Date.now(),
            lockedUntil: null,
            lastError: e.message,
            ...terminalPatch(def),
          })
          .where(ownershipPredicate(row.id, owner))
          .returning({ id: t.id })
        if (!updated[0]) return 'lost'
        logger.error(
          JSON.stringify(
            jobEvent('job.failed', row, {
              durationMs: Date.now() - startedAt,
              error: e.message,
            }),
          ),
        )
        telemetry.recordJob({
          type: row.type,
          kind: jobKind(def),
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
        })
        telemetry.recordJobRun(
          runRecord(row, def, 'failed', Date.now() - startedAt, e),
        )
        telemetry.captureException(e, {
          source: jobKind(def),
          jobType: row.type,
          jobId: row.id,
          attempt: Number(row.attempts),
          willRetry: false,
        })
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
      claimedWork.map(({ row, def, owner }) => runJob(row, def, now, owner)),
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
      await reapFinished(now)
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
        .where(
          and(
            eq(t.status, 'pending'),
            lte(t.runAt, now),
            or(isNull(t.lockedUntil), lte(t.lockedUntil, now)),
          ),
        )
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
