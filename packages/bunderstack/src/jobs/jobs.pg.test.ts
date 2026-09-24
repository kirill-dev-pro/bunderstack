import type { PgDatabase } from 'drizzle-orm/pg-core'

import { test, expect, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'
// A pg-dialect user table so withInternalTables/detectDialect pick the pg twins.
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { JobsDefs } from './define'

import { libsql } from '../database/libsql'
import { pglite } from '../database/pglite'
import { createDb } from '../db'
import { bunderstack } from '../index'
import { withInternalTables } from '../internal-tables'
import { bunderstackJobsPg } from '../internal-tables-pg'
import { provisionSchema } from '../provision-schema'
import { enqueueJob } from './queue'
import { createJobRunner } from './worker'
const marker = pgTable('jobs_pg_marker', { id: pgText('id').primaryKey() })

let db: Awaited<ReturnType<typeof createDb>>['db']

beforeAll(async () => {
  ;({ db } = await createDb(
    { marker },
    { url: 'memory://', dialect: 'pg', adapter: pglite() },
  ))
  const merged = withInternalTables({ marker })
  await provisionSchema(db as never, merged, { force: true })
})

function runner(defs: JobsDefs) {
  const r = createJobRunner({ db: db as never, defs, ctx: {} })
  r.setJobsFacade({
    enqueue: (name, input, opts) =>
      enqueueJob(db as never, defs, name, input, opts),
    tick: (now) => r.tick(now),
  })
  return r
}

test('pg: enqueue, claim, run to succeeded', async () => {
  const seen: unknown[] = []
  const defs: JobsDefs = {
    greet: {
      kind: 'job',
      input: v.object({ name: v.string() }),
      handler: async (input) => {
        seen.push(input)
      },
    },
  }
  const r = runner(defs)
  const { id } = await enqueueJob(db as never, defs, 'greet', { name: 'pg' })
  await r.tick()
  expect(seen).toEqual([{ name: 'pg' }])
  const rows = await (db as unknown as PgDatabase<never>)
    .select()
    .from(bunderstackJobsPg)
    .where(eq(bunderstackJobsPg.id, id))
  expect(rows[0]?.status).toBe('succeeded')
  expect(rows[0]?.attempts).toBe(1)
})

test('pg: dedupe key collapses duplicate enqueues', async () => {
  const defs: JobsDefs = { ok: { kind: 'job', handler: async () => {} } }
  const a = await enqueueJob(db as never, defs, 'ok', undefined, {
    dedupeKey: 'pg-once',
  })
  const b = await enqueueJob(db as never, defs, 'ok', undefined, {
    dedupeKey: 'pg-once',
  })
  expect(b.id).toBe(a.id)
})

test('pg: failure retries then fails with onFailed', async () => {
  let failed = false
  const defs: JobsDefs = {
    flaky: {
      kind: 'job',
      retries: 1,
      backoff: { baseMs: 10, factor: 1 },
      handler: async () => {
        throw new Error('pg boom')
      },
      onFailed: async () => {
        failed = true
      },
    },
  }
  const r = runner(defs)
  const t0 = Date.now()
  const { id } = await enqueueJob(db as never, defs, 'flaky', undefined, {
    runAt: t0,
  })
  await r.tick(t0)
  await r.tick(t0 + 1000)
  const rows = await (db as unknown as PgDatabase<never>)
    .select()
    .from(bunderstackJobsPg)
    .where(eq(bunderstackJobsPg.id, id))
  expect(rows[0]?.status).toBe('failed')
  expect(rows[0]?.lastError).toContain('pg boom')
  expect(failed).toBe(true)
})

test('pg: cron slots materialize and run through the queue execution path', async () => {
  const runs: Date[] = []
  const defs: JobsDefs = {
    everyMinute: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: async ({ scheduledFor }) => {
        runs.push(scheduledFor)
      },
    },
  }
  const r = runner(defs)
  // Target slot 2026-08-07 10:00:00 UTC = 1770372000000 ms
  const slotMs = 1_770_372_000_000
  await r.tick(slotMs)
  expect(runs).toEqual([new Date(slotMs)])
  const rows = await (db as unknown as PgDatabase<never>)
    .select()
    .from(bunderstackJobsPg)
    .where(eq(bunderstackJobsPg.type, 'cron:everyMinute'))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.status).toBe('succeeded')
  expect(rows[0]?.dedupeKey).toBe(String(slotMs))
})

const pgEvents = pgTable('pg_tx_events', { id: pgText('id').primaryKey() })
const pushOptions = { database: { schema: 'push' as const } }

function pgBackend(
  ran: string[],
  seen: number[] = [],
  ids: string[] = [],
  dedupeUntil: 'start' | 'finish' = 'finish',
) {
  return bunderstack({
    schema: { pgEvents },
    database: { adapter: pglite() },
    jobs: (j) =>
      j.define({
        record: j.job({
          input: v.object({ id: v.string() }),
          handler: ({ id }) => {
            ran.push(id)
          },
        }),
        fanOut: j.job({
          input: v.object({ id: v.string() }),
          handler: async ({ id }, ctx) => {
            await ctx.db.transaction(async (tx) => {
              await tx.insert(pgEvents).values({ id })
              await ctx.jobs.enqueue('record', { id }, { tx })
            })
          },
        }),
        sync: j.job({
          input: v.object({ version: v.number() }),
          dedupeUntil,
          handler: async ({ version }, ctx) => {
            seen.push(version)
            if (version === 1) {
              const { id } = await ctx.jobs.enqueue(
                'sync',
                { version: 2 },
                { dedupeKey: 'p1' },
              )
              ids.push(id)
            }
          },
        }),
      }),
  })
}

test('pg: enqueue with tx is claimable after commit and gone after rollback', async () => {
  const ran: string[] = []
  await using t = await pgBackend(ran).test(pushOptions)

  await t.app.db.transaction(async (tx) => {
    await tx.insert(pgEvents).values({ id: 'committed' })
    await t.app.jobs.enqueue('record', { id: 'committed' }, { tx })
  })
  await expect(
    t.app.db.transaction(async (tx) => {
      await tx.insert(pgEvents).values({ id: 'rolled-back' })
      await t.app.jobs.enqueue('record', { id: 'rolled-back' }, { tx })
      throw new Error('rollback on purpose')
    }),
  ).rejects.toThrow('rollback on purpose')

  const report = await t.jobs.runUntilIdle()
  expect(ran).toEqual(['committed'])
  expect(report.ran).toBe(1)
  expect(await t.jobs.inspect()).toHaveLength(1)
})

test('pg: dedupe inside a transaction collapses with an existing pending row', async () => {
  const ran: string[] = []
  await using t = await pgBackend(ran).test(pushOptions)

  const first = await t.app.jobs.enqueue(
    'record',
    { id: 'first' },
    { dedupeKey: 'k' },
  )
  const [inside, again] = await t.app.db.transaction(async (tx) => [
    await t.app.jobs.enqueue(
      'record',
      { id: 'second' },
      { tx, dedupeKey: 'k' },
    ),
    await t.app.jobs.enqueue('record', { id: 'third' }, { tx, dedupeKey: 'k' }),
  ])
  expect(inside.id).toBe(first.id)
  expect(again.id).toBe(first.id)

  await t.jobs.runUntilIdle()
  expect(ran).toEqual(['first'])
})

test('pg: job handlers enqueue through ctx.jobs inside their own transaction', async () => {
  const ran: string[] = []
  await using t = await pgBackend(ran).test(pushOptions)

  await t.app.jobs.enqueue('fanOut', { id: 'child' })
  const report = await t.jobs.runUntilIdle()
  expect(report.ran).toBe(2)
  expect(ran).toEqual(['child'])
})

test('pg: enqueue rejects a transaction from a different database dialect', async () => {
  const ran: string[] = []
  await using t = await pgBackend(ran).test(pushOptions)
  const notes = sqliteTable('tx_dialect_notes', {
    id: sqliteText('id').primaryKey(),
  })
  const sqlite = await createDb(
    { notes },
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  )
  try {
    await sqlite.db.transaction(async (tx) => {
      await expect(
        t.app.jobs.enqueue('record', { id: 'x' }, { tx: tx as never }),
      ).rejects.toThrow(
        '[bunderstack] enqueue tx belongs to a different database dialect',
      )
    })
  } finally {
    await sqlite.close?.()
  }
  expect(await t.jobs.inspect()).toHaveLength(0)
})

test("pg: dedupeUntil 'start' queues a newer row while the first runs", async () => {
  const seen: number[] = []
  const ids: string[] = []
  await using t = await pgBackend([], seen, ids, 'start').test(pushOptions)

  const first = await t.app.jobs.enqueue(
    'sync',
    { version: 1 },
    { dedupeKey: 'p1' },
  )
  const burst = await t.app.jobs.enqueue(
    'sync',
    { version: 0 },
    { dedupeKey: 'p1' },
  )
  expect(burst.id).toBe(first.id)

  const report = await t.jobs.runUntilIdle()
  expect(seen).toEqual([1, 2])
  expect(ids).toHaveLength(1)
  expect(ids[0]).not.toBe(first.id)
  expect(report.ran).toBe(2)
})

test("pg: dedupeUntil 'finish' collapses into the running row", async () => {
  const seen: number[] = []
  const ids: string[] = []
  await using t = await pgBackend([], seen, ids, 'finish').test(pushOptions)

  const first = await t.app.jobs.enqueue(
    'sync',
    { version: 1 },
    { dedupeKey: 'p1' },
  )
  const report = await t.jobs.runUntilIdle()
  expect(seen).toEqual([1])
  expect(ids).toEqual([first.id])
  expect(report.ran).toBe(1)
})
