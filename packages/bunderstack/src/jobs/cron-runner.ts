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
}): Promise<CronRunResult> {
  const { db, taskId, schedule, slot, now, run } = args
  const leaseMs = args.leaseMs ?? LEASE_MS
  const heartbeatIntervalMs =
    args.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseMs / 4))

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
    .returning({ taskId: t.taskId })

  if (!inserted[0]) {
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
      .returning({ taskId: t.taskId })
    if (!reclaimed[0]) return { status: 'running' }
  }

  let heartbeatTimer: Timer | undefined
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  heartbeatTimer = setInterval(async () => {
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
          ),
        )
    } catch {
      // Best effort renewal
    }
  }, heartbeatIntervalMs)

  try {
    await run(new Date(slot))

    stopHeartbeat()

    const updated = await db
      .update(t)
      .set({ status: 'succeeded', lockedUntil: null, finishedAt: Date.now() })
      .where(
        and(
          eq(t.taskId, taskId),
          eq(t.scheduledAt, slot),
          eq(t.status, 'running'),
          eq(t.startedAt, now),
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
    stopHeartbeat()

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
        ),
      )
    throw error
  } finally {
    stopHeartbeat()
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
    run: (scheduledFor) =>
      definition.handler({ scheduledFor }, args.ctx as never),
  })
}
