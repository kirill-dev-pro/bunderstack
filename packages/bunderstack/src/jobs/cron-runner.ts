import { and, eq, lt, or, sql } from 'drizzle-orm'

import type { AnyDb } from '../dialect'
import type { BackgroundDefs } from './define'

import { cronRunsTableFor } from '../internal-tables'
import { cronMatches, parseCron } from './cron'

const LEASE_MS = 60_000

export type CronRunResult =
  | { status: 'succeeded' }
  | { status: 'duplicate' }
  | { status: 'running' }

export async function runScheduledSlot(args: {
  db: AnyDb
  taskId: string
  schedule: string
  slot: number
  now: number
  run: (scheduledFor: Date) => Promise<void> | void
  leaseMs?: number
  heartbeatIntervalMs?: number
  heartbeatCleanupTimeoutMs?: number
}): Promise<CronRunResult> {
  const { db, taskId, schedule, slot, now, run } = args
  const leaseMs = args.leaseMs ?? LEASE_MS
  const heartbeatIntervalMs =
    args.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseMs / 4))
  const heartbeatCleanupTimeoutMs = args.heartbeatCleanupTimeoutMs ?? 1_000

  if (slot % 60_000 !== 0 || !cronMatches(parseCron(schedule), slot)) {
    throw new Error('[bunderstack] cron slot does not match its schedule')
  }

  const t = cronRunsTableFor(db)
  const leaseUntil = now + leaseMs
  const inserted = await db
    .insert(t)
    .values({
      taskId,
      scheduledAt: slot,
      status: 'running',
      attempts: 1,
      lockedUntil: leaseUntil,
      startedAt: now,
    })
    .onConflictDoNothing({ target: [t.taskId, t.scheduledAt] })
    .returning({ taskId: t.taskId, attempts: t.attempts })

  let ownershipAttempt: number
  if (inserted[0]) {
    ownershipAttempt = Number(inserted[0].attempts)
  } else {
    const existing = await db
      .select({ status: t.status, lockedUntil: t.lockedUntil })
      .from(t)
      .where(and(eq(t.taskId, taskId), eq(t.scheduledAt, slot)))
      .limit(1)
    const row = existing[0]
    if (!row || row.status === 'succeeded') return { status: 'duplicate' }
    if (row.status === 'running' && Number(row.lockedUntil) >= now) {
      return { status: 'running' }
    }
    const reclaimed = await db
      .update(t)
      .set({
        status: 'running',
        lockedUntil: leaseUntil,
        startedAt: now,
        attempts: sql`${t.attempts} + 1`,
        lastError: null,
      })
      .where(
        and(
          eq(t.taskId, taskId),
          eq(t.scheduledAt, slot),
          or(eq(t.status, 'failed'), lt(t.lockedUntil, now)),
        ),
      )
      .returning({ taskId: t.taskId, attempts: t.attempts })
    const reclaimedRow = reclaimed[0]
    if (!reclaimedRow) return { status: 'running' }
    ownershipAttempt = Number(reclaimedRow.attempts)
  }

  let heartbeatTimer: Timer | undefined
  let heartbeatInFlight: Promise<void> | undefined
  let heartbeatStopped = false

  const scheduleHeartbeat = () => {
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined
      if (heartbeatStopped) return

      heartbeatInFlight = (async () => {
        try {
          const renewUntil = Date.now() + leaseMs
          await db
            .update(t)
            .set({ lockedUntil: renewUntil })
            .where(
              and(
                eq(t.taskId, taskId),
                eq(t.scheduledAt, slot),
                eq(t.status, 'running'),
                eq(t.startedAt, now),
                eq(t.attempts, ownershipAttempt),
              ),
            )
        } catch {
          // Best effort renewal
        }
      })()

      void heartbeatInFlight.finally(() => {
        heartbeatInFlight = undefined
        if (!heartbeatStopped) scheduleHeartbeat()
      })
    }, heartbeatIntervalMs)
  }

  const stopHeartbeat = async () => {
    heartbeatStopped = true
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = undefined
    }
    const inFlight = heartbeatInFlight
    if (!inFlight) return

    let cleanupTimer: Timer | undefined
    try {
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, heartbeatCleanupTimeoutMs)
        }),
      ])
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer)
    }
  }

  scheduleHeartbeat()

  try {
    await run(new Date(slot))

    const updated = await db
      .update(t)
      .set({ status: 'succeeded', lockedUntil: null, finishedAt: Date.now() })
      .where(
        and(
          eq(t.taskId, taskId),
          eq(t.scheduledAt, slot),
          eq(t.status, 'running'),
          eq(t.startedAt, now),
          eq(t.attempts, ownershipAttempt),
        ),
      )
      .returning({ taskId: t.taskId })

    if (!updated[0]) {
      throw new Error(
        '[bunderstack] cron lease ownership was lost during execution',
      )
    }

    return { status: 'succeeded' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(t)
      .set({
        status: 'failed',
        lockedUntil: null,
        lastError: message,
        finishedAt: Date.now(),
      })
      .where(
        and(
          eq(t.taskId, taskId),
          eq(t.scheduledAt, slot),
          eq(t.status, 'running'),
          eq(t.startedAt, now),
          eq(t.attempts, ownershipAttempt),
        ),
      )
    throw error
  } finally {
    await stopHeartbeat()
  }
}

export async function runCronSlot(args: {
  db: AnyDb
  defs: BackgroundDefs
  ctx: Record<string, unknown>
  name: string
  slot: number
  now: number
  leaseMs?: number
  heartbeatIntervalMs?: number
  heartbeatCleanupTimeoutMs?: number
}): Promise<CronRunResult> {
  const definition = args.defs[args.name]
  if (!definition || definition.kind !== 'cron') {
    throw new Error(`[bunderstack] unknown cron "${args.name}"`)
  }
  return runScheduledSlot({
    db: args.db,
    taskId: `cron:${args.name}`,
    schedule: definition.schedule,
    slot: args.slot,
    now: args.now,
    leaseMs: args.leaseMs,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    heartbeatCleanupTimeoutMs: args.heartbeatCleanupTimeoutMs,
    run: (scheduledFor) =>
      definition.handler({ scheduledFor }, args.ctx as never),
  })
}
