import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { JobsDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackJobs, withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { enqueueJob } from './queue'
import { createJobRunner } from './worker'

let db: LibSQLDatabase<Record<string, never>>

beforeEach(async () => {
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

const job: JobsDefs = {
  work: { kind: 'job', handler: async () => {} },
}
const now = Date.UTC(2026, 0, 1, 0, 1, 30)
const hour = 3_600_000

test('nextDueAt is null without work', async () => {
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBeNull()
})

test('nextDueAt returns the run_at of the earliest pending job', async () => {
  await enqueueJob(db, job, 'work', undefined, { runAt: now + 9_000 }, now)
  await enqueueJob(db, job, 'work', undefined, { runAt: now + 5_000 }, now)
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(now + 5_000)
})

test('nextDueAt never returns a time before now', async () => {
  await enqueueJob(db, job, 'work', undefined, { runAt: now - 60_000 }, now)
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(now)
})

test('nextDueAt includes the lease end of a running job', async () => {
  const { id } = await enqueueJob(db, job, 'work', undefined, {}, now)
  await db
    .update(bunderstackJobs)
    .set({ status: 'running', lockedUntil: now + 30_000 })
    .where(eq(bunderstackJobs.id, id))
  const runner = createJobRunner({ db, defs: job, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(now + 30_000)
})

test('nextDueAt includes the next cron slot', async () => {
  const defs: JobsDefs = {
    every5: { kind: 'cron', schedule: '*/5 * * * *', handler: async () => {} },
  }
  const runner = createJobRunner({ db, defs, ctx: {} })
  expect(await runner.nextDueAt(now, now + hour)).toBe(
    Date.UTC(2026, 0, 1, 0, 5),
  )
})
