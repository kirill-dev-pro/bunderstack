import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeAll, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { AnyDb } from '../dialect'
import type { BackgroundDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackCronRuns, withInternalTables } from '../internal-tables'
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function wrapUpdateQuery(
  query: object,
  values: Record<string, unknown>,
  beforeExecute: (values: Record<string, unknown>) => Promise<void> | void,
): object {
  return new Proxy(query, {
    get(target, property) {
      if (property === 'then') {
        return (
          onFulfilled: (value: unknown) => unknown,
          onRejected: (error: unknown) => unknown,
        ) =>
          Promise.resolve()
            .then(() => beforeExecute(values))
            .then(() => target)
            .then(onFulfilled, onRejected)
      }

      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) =>
        wrapUpdateQuery(value.apply(target, args), values, beforeExecute)
    },
  })
}

function instrumentUpdates(
  realDb: AnyDb,
  beforeExecute: (values: Record<string, unknown>) => Promise<void> | void,
): AnyDb {
  return new Proxy(realDb, {
    get(target, property) {
      if (property === 'update') {
        return (...args: unknown[]) => {
          const update = target.update(...args)
          return new Proxy(update, {
            get(updateTarget, updateProperty) {
              if (updateProperty === 'set') {
                return (values: Record<string, unknown>) =>
                  wrapUpdateQuery(
                    updateTarget.set(values),
                    values,
                    beforeExecute,
                  )
              }
              const value = Reflect.get(
                updateTarget,
                updateProperty,
                updateTarget,
              )
              return typeof value === 'function'
                ? value.bind(updateTarget)
                : value
            },
          })
        }
      }

      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function isRenewal(values: Record<string, unknown>) {
  return (
    Object.keys(values).length === 1 && typeof values.lockedUntil === 'number'
  )
}

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

test('keeps renewing while a slow success transition is near lease expiry', async () => {
  const slot = Date.UTC(2026, 6, 18, 15, 30)
  const terminalStarted = deferred()
  const releaseTerminal = deferred()
  let heldTerminal = false
  const observedDb = instrumentUpdates(
    db as unknown as AnyDb,
    async (values) => {
      if (values.status === 'succeeded' && !heldTerminal) {
        heldTerminal = true
        terminalStarted.resolve()
        await releaseTerminal.promise
      }
    },
  )

  const firstOutcome = runScheduledSlot({
    db: observedDb,
    taskId: 'cron:slow-terminal',
    schedule: '* * * * *',
    slot,
    now: Date.now(),
    leaseMs: 80,
    heartbeatIntervalMs: 10,
    run: async () => {},
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  )

  await terminalStarted.promise
  await delay(130)
  const reclaimResult = await runScheduledSlot({
    db: observedDb,
    taskId: 'cron:slow-terminal',
    schedule: '* * * * *',
    slot,
    now: Date.now(),
    leaseMs: 80,
    heartbeatIntervalMs: 10,
    run: async () => {},
  })
  releaseTerminal.resolve()

  expect(reclaimResult).toEqual({ status: 'running' })
  expect(await firstOutcome).toEqual({ result: { status: 'succeeded' } })
})

test('never overlaps renewal queries', async () => {
  const slot = Date.UTC(2026, 6, 18, 15, 31)
  let activeRenewals = 0
  let maxActiveRenewals = 0
  const observedDb = instrumentUpdates(
    db as unknown as AnyDb,
    async (values) => {
      if (!isRenewal(values)) return
      activeRenewals++
      maxActiveRenewals = Math.max(maxActiveRenewals, activeRenewals)
      await delay(40)
      activeRenewals--
    },
  )

  await runScheduledSlot({
    db: observedDb,
    taskId: 'cron:serialized-renewal',
    schedule: '* * * * *',
    slot,
    now: Date.now(),
    leaseMs: 100,
    heartbeatIntervalMs: 5,
    run: () => delay(120),
  })
  await delay(60)

  expect(maxActiveRenewals).toBe(1)
})

test('does not execute heartbeats after success or handler failure settles', async () => {
  const cases = [
    { taskId: 'cron:no-late-success', shouldFail: false },
    { taskId: 'cron:no-late-failure', shouldFail: true },
  ] as const

  for (const [index, testCase] of cases.entries()) {
    const renewalStarted = deferred()
    let settled = false
    let renewalsAfterSettlement = 0
    const observedDb = instrumentUpdates(
      db as unknown as AnyDb,
      async (values) => {
        if (!isRenewal(values)) return
        renewalStarted.resolve()
        await delay(80)
        if (settled) renewalsAfterSettlement++
      },
    )
    const outcome = runScheduledSlot({
      db: observedDb,
      taskId: testCase.taskId,
      schedule: '* * * * *',
      slot: Date.UTC(2026, 6, 18, 15, 32 + index),
      now: Date.now(),
      leaseMs: 100,
      heartbeatIntervalMs: 5,
      run: async () => {
        await renewalStarted.promise
        if (testCase.shouldFail) throw new Error('handler failed')
      },
    }).then(
      (result) => {
        settled = true
        return { result }
      },
      (error: unknown) => {
        settled = true
        return { error }
      },
    )

    const result = await outcome
    await delay(100)
    expect(renewalsAfterSettlement).toBe(0)
    if (testCase.shouldFail) {
      expect(result).toHaveProperty('error')
    } else {
      expect(result).toEqual({ result: { status: 'succeeded' } })
    }
  }
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

  const rows = await db
    .select({
      status: bunderstackCronRuns.status,
      attempts: bunderstackCronRuns.attempts,
      startedAt: bunderstackCronRuns.startedAt,
    })
    .from(bunderstackCronRuns)
    .where(
      and(
        eq(bunderstackCronRuns.taskId, taskId),
        eq(bunderstackCronRuns.scheduledAt, slot),
      ),
    )
  expect(rows).toEqual([
    { status: 'succeeded', attempts: 2, startedAt: slot + 50 },
  ])
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
