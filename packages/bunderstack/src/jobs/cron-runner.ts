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
}): Promise<CronRunResult> {
  const { db, taskId, schedule, slot, now, run } = args
  if (slot % 60_000 !== 0 || !cronMatches(parseCron(schedule), slot)) {
    throw new Error('[bunderstack] cron slot does not match its schedule')
  }

  const t = cronRunsTableFor(db)
  const leaseUntil = now + LEASE_MS
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

  try {
    await run(new Date(slot))
    await db
      .update(t)
      .set({ status: 'succeeded', lockedUntil: null, finishedAt: Date.now() })
      .where(and(eq(t.taskId, taskId), eq(t.scheduledAt, slot)))
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
      .where(and(eq(t.taskId, taskId), eq(t.scheduledAt, slot)))
    throw error
  }
}

export async function runCronSlot(args: {
  db: AnyDb
  defs: BackgroundDefs
  ctx: Record<string, unknown>
  name: string
  slot: number
  now: number
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
    run: (scheduledFor) =>
      definition.handler({ scheduledFor }, args.ctx as never),
  })
}
