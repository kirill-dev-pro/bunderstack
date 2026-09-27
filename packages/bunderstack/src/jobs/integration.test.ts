import { test, expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { libsql } from '../database/libsql'
import { pglite } from '../database/pglite'
import { createDb } from '../db'
import { bunderstack } from '../index'
import { provision } from '../provision-schema'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
})

test('app.jobs enqueues without implicit execution and explicit worker runs the handler', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) =>
      j.define({
        writeNote: j.job({
          input: v.object({ id: v.string(), body: v.string() }),
          handler: async (input, ctx) => {
            await ctx.db
              .insert(notes)
              .values({ id: input.id, body: input.body })
          },
        }),
      }),
  }).start()
  await provision(app, { force: true })

  await app.jobs.enqueue('writeNote', { id: 'n1', body: 'from a job' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await app.db.select().from(notes).where(eq(notes.id, 'n1'))).toEqual(
    [],
  )

  await app.jobs.tick()
  const rows = await app.db.select().from(notes).where(eq(notes.id, 'n1'))
  expect(rows[0]?.body).toBe('from a job')
  await app.close()

  // Type-level checks (compile-time; the expressions are never executed).
  // @ts-expect-error unknown job name
  const _bad = () => app.jobs.enqueue('nope')
  // @ts-expect-error wrong payload shape
  const _badInput = () => app.jobs.enqueue('writeNote', { id: 42 })
  void _bad
  void _badInput
})

test('oRPC context exposes the jobs facade', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
    api: (o) => ({
      kick: o.public.handler(async ({ context }) => {
        const { id } = await context.jobs.enqueue('noop')
        return { id }
      }),
    }),
  }).start()
  await provision(app, { force: true })

  const res = await app.handler(
    new Request('http://localhost/api/rpc/kick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: null }),
    }),
  )
  expect(res.status).toBe(200)
})

test('the built-in storage sweep is registered as an ordinary cron', async () => {
  const backend = bunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    storage: {
      local: './uploads',
      defaultBucket: 'files',
      buckets: { files: {} },
    },
  } as never)
  expect(backend.inspect().background.cron.map((c) => c.name)).toContain(
    'bunderstack:storage-sweep',
  )
})

test('an app without jobs still has a facade; enqueue throws', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
  }).start()
  await expect(
    (
      app.jobs as unknown as { enqueue: (n: string) => Promise<unknown> }
    ).enqueue('x'),
  ).rejects.toThrow(/no jobs configured/)
  await app.jobs.tick() // no-op, must not throw
})

const txEvents = sqliteTable('tx_events', { id: text('id').primaryKey() })
// libSQL replaces an in-memory database with a fresh one after the first
// interactive transaction, so transactional tests run on a temporary file.
const pushOptions = {
  database: { schema: 'push' as const, mode: 'temporary' as const },
}

function transactionalBackend(ran: string[]) {
  return bunderstack({
    schema: { txEvents },
    database: { adapter: libsql() },
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
              await tx.insert(txEvents).values({ id })
              await ctx.jobs.enqueue('record', { id }, { tx })
            })
          },
        }),
      }),
  })
}

test('libsql: enqueue with tx is claimable after commit and gone after rollback', async () => {
  const ran: string[] = []
  await using t = await transactionalBackend(ran).test(pushOptions)

  await t.app.db.transaction(async (tx) => {
    await tx.insert(txEvents).values({ id: 'committed' })
    await t.app.jobs.enqueue('record', { id: 'committed' }, { tx })
  })
  await expect(
    t.app.db.transaction(async (tx) => {
      await tx.insert(txEvents).values({ id: 'rolled-back' })
      await t.app.jobs.enqueue('record', { id: 'rolled-back' }, { tx })
      throw new Error('rollback on purpose')
    }),
  ).rejects.toThrow('rollback on purpose')

  const report = await t.jobs.runUntilIdle()
  expect(ran).toEqual(['committed'])
  expect(report.ran).toBe(1)
  expect(await t.jobs.inspect()).toHaveLength(1)

  // Type-level check: `tx` is the app's transaction type, not any object.
  // @ts-expect-error a string is not a transaction
  const _badTx = () => t.app.jobs.enqueue('record', { id: 'x' }, { tx: 'nope' })
  void _badTx
})

test('libsql: dedupe inside a transaction collapses with an existing pending row', async () => {
  const ran: string[] = []
  await using t = await transactionalBackend(ran).test(pushOptions)

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

test('libsql: job handlers enqueue through ctx.jobs inside their own transaction', async () => {
  const ran: string[] = []
  await using t = await transactionalBackend(ran).test(pushOptions)

  await t.app.jobs.enqueue('fanOut', { id: 'child' })
  const report = await t.jobs.runUntilIdle()
  expect(report.ran).toBe(2)
  expect(ran).toEqual(['child'])
  expect(await t.app.db.select().from(txEvents)).toEqual([{ id: 'child' }])
})

test('enqueue rejects a transaction from a different database dialect', async () => {
  const ran: string[] = []
  await using t = await transactionalBackend(ran).test(pushOptions)
  const marker = pgTable('tx_dialect_marker', { id: pgText('id').primaryKey() })
  const pg = await createDb(
    { marker },
    { url: 'memory://', dialect: 'pg', adapter: pglite() },
  )
  try {
    await pg.db.transaction(async (tx) => {
      await expect(
        t.app.jobs.enqueue('record', { id: 'x' }, { tx: tx as never }),
      ).rejects.toThrow(
        '[bunderstack] enqueue tx belongs to a different database dialect',
      )
    })
  } finally {
    await pg.close?.()
  }
  expect(await t.jobs.inspect()).toHaveLength(0)
})

function dedupeWindowBackend(
  dedupeUntil: 'start' | 'finish' | undefined,
  seen: number[],
  ids: string[],
) {
  return bunderstack({
    schema: {},
    database: { adapter: libsql() },
    jobs: (j) =>
      j.define({
        sync: j.job({
          input: v.object({ version: v.number() }),
          ...(dedupeUntil ? { dedupeUntil } : {}),
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

test("libsql: dedupeUntil 'start' queues a newer row while the first runs", async () => {
  const seen: number[] = []
  const ids: string[] = []
  await using t = await dedupeWindowBackend('start', seen, ids).test(
    pushOptions,
  )

  const first = await t.app.jobs.enqueue(
    'sync',
    { version: 1 },
    { dedupeKey: 'p1' },
  )
  // A burst before the claim still collapses into the pending row.
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

test("libsql: dedupeUntil 'finish' collapses into the running row", async () => {
  const seen: number[] = []
  const ids: string[] = []
  await using t = await dedupeWindowBackend('finish', seen, ids).test(
    pushOptions,
  )

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

test('libsql: default dedupe window keeps collapsing into the running row', async () => {
  const seen: number[] = []
  const ids: string[] = []
  await using t = await dedupeWindowBackend(undefined, seen, ids).test(
    pushOptions,
  )

  const first = await t.app.jobs.enqueue(
    'sync',
    { version: 1 },
    { dedupeKey: 'p1' },
  )
  await t.jobs.runUntilIdle()
  expect(seen).toEqual([1])
  expect(ids).toEqual([first.id])
})

test('start never runs background work; a host drives it with tick', async () => {
  let ran = 0
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) =>
      j.define({
        count: j.job({ handler: async () => void ran++ }),
      }),
  }).start()
  try {
    await provision(app, { force: true })
    await app.jobs.enqueue('count', undefined)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(ran).toBe(0)
    expect('startWorker' in app).toBe(false)
    expect('runWorker' in app).toBe(false)
    const result = await app.jobs.tick()
    expect(result.ran).toBe(1)
    expect(ran).toBe(1)
  } finally {
    await app.close()
  }
})
