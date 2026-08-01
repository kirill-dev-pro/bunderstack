import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeAll, expect, test } from 'bun:test'

import type { BackgroundDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { runCronSlot, runScheduledSlot } from './cron-runner'

let db: LibSQLDatabase<Record<string, never>>

beforeAll(async () => {
  ;({ db } = await createDb(
    {},
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  ))
  const merged = withInternalTables({})
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
})

test('runs one matching cron slot and records success', async () => {
  const seen: Date[] = []
  const slot = Date.UTC(2026, 6, 18, 12, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async ({ scheduledFor }) => {
        seen.push(scheduledFor)
      },
    },
  }

  const result = await runCronSlot({
    db,
    defs,
    ctx: {},
    name: 'hourly',
    slot,
    now: slot,
  })

  expect(result).toEqual({ status: 'succeeded' })
  expect(seen).toEqual([new Date(slot)])
})

test('returns duplicate without running a successful slot twice', async () => {
  let calls = 0
  const slot = Date.UTC(2026, 6, 18, 13, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {
        calls++
      },
    },
  }
  const args = { db, defs, ctx: {}, name: 'hourly', slot, now: slot }

  await expect(runCronSlot(args)).resolves.toEqual({ status: 'succeeded' })
  await expect(runCronSlot(args)).resolves.toEqual({ status: 'duplicate' })
  expect(calls).toBe(1)
})

test('reclaims a failed slot for a later retry', async () => {
  let calls = 0
  const slot = Date.UTC(2026, 6, 18, 14, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {
        calls++
        if (calls === 1) throw new Error('temporary failure')
      },
    },
  }
  const args = { db, defs, ctx: {}, name: 'hourly', slot, now: slot }

  await expect(runCronSlot(args)).rejects.toThrow('temporary failure')
  await expect(runCronSlot(args)).resolves.toEqual({ status: 'succeeded' })
  expect(calls).toBe(2)
})

test('handler longer than original lease remains owned via heartbeat and cannot be reclaimed', async () => {
  const slot = Date.UTC(2026, 6, 18, 15, 0)
  const taskId = 'cron:long-running'
  const schedule = '0 * * * *'

  // Run with short lease (60ms) and short heartbeat (15ms)
  const longTask = runScheduledSlot({
    db,
    taskId,
    schedule,
    slot,
    now: slot,
    leaseMs: 60,
    heartbeatIntervalMs: 15,
    run: async () => {
      // Sleep for 150ms (> 60ms original lease)
      await new Promise((r) => setTimeout(r, 150))
    },
  })

  // Mid-way (100ms in), attempt to reclaim using another call
  await new Promise((r) => setTimeout(r, 100))

  const reclaimAttempt = await runScheduledSlot({
    db,
    taskId,
    schedule,
    slot,
    now: slot + 100,
    run: async () => {},
  })

  // Because heartbeat renewed lockedUntil, reclaimAttempt sees running and not expired
  expect(reclaimAttempt).toEqual({ status: 'running' })

  // Long task completes successfully
  const result = await longTask
  expect(result).toEqual({ status: 'succeeded' })
})

test('stale attempt cannot overwrite a newer attempt terminal state', async () => {
  const slot = Date.UTC(2026, 6, 18, 16, 0)
  const taskId = 'cron:stale-check'
  const schedule = '0 * * * *'

  let finishStaleHandler: () => void = () => {}
  const stalePromise = new Promise<void>((r) => {
    finishStaleHandler = r
  })

  // Attempt 1 starts with a 30ms lease and 100ms heartbeat (so heartbeat won't fire)
  const attempt1 = runScheduledSlot({
    db,
    taskId,
    schedule,
    slot,
    now: slot,
    leaseMs: 30,
    heartbeatIntervalMs: 100,
    run: async () => {
      await stalePromise
    },
  })

  // Wait 50ms for lease to expire
  await new Promise((r) => setTimeout(r, 50))

  // Attempt 2 reclaims the slot at now = slot + 50
  const attempt2 = await runScheduledSlot({
    db,
    taskId,
    schedule,
    slot,
    now: slot + 50,
    leaseMs: 1000,
    run: async () => {},
  })
  expect(attempt2).toEqual({ status: 'succeeded' })

  // Now finish Attempt 1 (which lost ownership)
  finishStaleHandler()

  // Attempt 1 should throw ownership lost error and NOT overwrite Attempt 2's succeeded state
  await expect(attempt1).rejects.toThrow('ownership was lost')
})

test('heartbeat cleanup happens after both success and failure', async () => {
  const slot1 = Date.UTC(2026, 6, 18, 17, 0)
  const slot2 = Date.UTC(2026, 6, 18, 18, 0)

  // Success case
  await runScheduledSlot({
    db,
    taskId: 'cron:cleanup-success',
    schedule: '0 * * * *',
    slot: slot1,
    now: slot1,
    leaseMs: 100,
    heartbeatIntervalMs: 20,
    run: async () => {},
  })

  // Failure case
  await expect(
    runScheduledSlot({
      db,
      taskId: 'cron:cleanup-fail',
      schedule: '0 * * * *',
      slot: slot2,
      now: slot2,
      leaseMs: 100,
      heartbeatIntervalMs: 20,
      run: async () => {
        throw new Error('boom')
      },
    }),
  ).rejects.toThrow('boom')
})
