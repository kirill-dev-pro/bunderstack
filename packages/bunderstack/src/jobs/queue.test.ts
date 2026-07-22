import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { test, expect, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { JobsDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackJobs, withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { enqueueJob } from './queue'

let db: LibSQLDatabase<Record<string, never>>

const defs: JobsDefs = {
  greet: {
    kind: 'job',
    input: z.object({ name: z.string() }),
    handler: async () => {},
  },
  bare: { kind: 'job', handler: async () => {} },
}

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

test('enqueue inserts a pending row with parsed payload', async () => {
  const { id } = await enqueueJob(db, defs, 'greet', { name: 'kirill' })
  expect(id.startsWith('job_')).toBe(true)
  const rows = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id))
  expect(rows[0]?.status).toBe('pending')
  expect(rows[0]?.type).toBe('greet')
  expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ name: 'kirill' })
  expect(rows[0]!.runAt).toBeLessThanOrEqual(Date.now())
  expect(rows[0]!.attempts).toBe(0)
})

test('unknown queue job name throws', async () => {
  await expect(enqueueJob(db, defs, 'nope', {})).rejects.toThrow(
    /unknown queue job/,
  )
})

test('cron declarations cannot be enqueued', async () => {
  const cronDefs: JobsDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {},
    },
  }
  await expect(enqueueJob(db, cronDefs, 'hourly', undefined)).rejects.toThrow(
    /unknown queue job/,
  )
})

test('payload failing zod parse throws at the enqueue site', async () => {
  await expect(enqueueJob(db, defs, 'greet', { name: 42 })).rejects.toThrow()
})

test('delay and runAt land in run_at', async () => {
  const before = Date.now()
  const { id } = await enqueueJob(db, defs, 'bare', undefined, {
    delay: 60_000,
  })
  const [row] = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id))
  expect(row!.runAt).toBeGreaterThanOrEqual(before + 60_000)

  const at = Date.now() + 120_000
  const { id: id2 } = await enqueueJob(db, defs, 'bare', undefined, {
    runAt: new Date(at),
  })
  const [row2] = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id2))
  expect(row2!.runAt).toBe(at)
})

test('duplicate dedupeKey is a no-op returning the existing id', async () => {
  const a = await enqueueJob(db, defs, 'bare', undefined, { dedupeKey: 'once' })
  const b = await enqueueJob(db, defs, 'bare', undefined, { dedupeKey: 'once' })
  expect(b.id).toBe(a.id)
  const rows = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.dedupeKey, 'once'))
  expect(rows).toHaveLength(1)
})

test('same dedupeKey on a different type is a distinct job', async () => {
  const a = await enqueueJob(db, defs, 'bare', undefined, { dedupeKey: 'k' })
  const b = await enqueueJob(
    db,
    defs,
    'greet',
    { name: 'x' },
    { dedupeKey: 'k' },
  )
  expect(b.id).not.toBe(a.id)
})
