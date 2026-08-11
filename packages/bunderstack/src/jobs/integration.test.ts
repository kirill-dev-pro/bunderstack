import { test, expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
})

test('app.jobs enqueues without implicit execution and explicit worker runs the handler', async () => {
  const app = await createBunderstack({
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
  })
  await provision(app, { force: true })

  await app.jobs.enqueue('writeNote', { id: 'n1', body: 'from a job' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await app.db.select().from(notes).where(eq(notes.id, 'n1'))).toEqual(
    [],
  )

  const worker = await app.startWorker({ pollIntervalMs: 1 })
  let rows: { body: string }[] = []
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    rows = await app.db.select().from(notes).where(eq(notes.id, 'n1'))
    if (rows.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await worker.close()
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

test('tRPC ctx exposes the jobs facade', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
    trpc: (t) =>
      t.router({
        kick: t.procedure.mutation(async ({ ctx }) => {
          const { id } = await ctx.jobs.enqueue('noop')
          return { id }
        }),
      }),
  })
  await provision(app, { force: true })

  const res = await app.handler(
    new Request('http://localhost/api/trpc/kick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: null }),
    }),
  )
  expect(res.status).toBe(200)
})

test('the built-in storage sweep is registered as an ordinary cron', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    storage: {
      local: './uploads',
      defaultBucket: 'files',
      buckets: { files: {} },
    },
  } as never)
  expect(app.manifest.background.cron.map((c) => c.name)).toContain(
    'bunderstack:storage-sweep',
  )
  await app.close()
})

test('runWorker owns the application lifecycle until its signal aborts', async () => {
  const controller = new AbortController()
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
  })
  await provision(app, { force: true })

  const running = app.runWorker({
    signal: controller.signal,
    pollIntervalMs: 1,
  })
  controller.abort()

  await running
  expect(app.status).toBe('closed')
})

test('an app without jobs still has a facade; enqueue throws', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
  })
  await expect(
    (
      app.jobs as unknown as { enqueue: (n: string) => Promise<unknown> }
    ).enqueue('x'),
  ).rejects.toThrow(/no jobs configured/)
  await app.jobs.tick() // no-op, must not throw
})

test('introspection mode boots with jobs configured', async () => {
  const previous = process.env.BUNDERSTACK_INTROSPECT
  process.env.BUNDERSTACK_INTROSPECT = '1'
  let runs = 0
  try {
    const app = await createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter: libsql() },
      jobs: (j) =>
        j.define({
          noop: j.job({
            handler: async () => {
              runs++
            },
          }),
          scheduled: j.cron({
            schedule: '* * * * *',
            handler: async () => {
              runs++
            },
          }),
        }),
    })
    expect(app.manifest).toBeDefined()
    const worker = await app.startWorker()
    await app.runWorker()
    expect(runs).toBe(0)
    await worker.close()
    await app.close()
  } finally {
    if (previous === undefined) delete process.env.BUNDERSTACK_INTROSPECT
    else process.env.BUNDERSTACK_INTROSPECT = previous
  }
})

test('runWorker rejects process-local realtime by default', async () => {
  const prevRedis = process.env.REDIS_URL
  delete process.env.REDIS_URL
  try {
    const app = await createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter: libsql() },
      realtime: true,
      jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
    })
    await provision(app, { force: true })

    await expect(
      app.runWorker({ signal: AbortSignal.abort(), pollIntervalMs: 1 }),
    ).rejects.toThrow(
      '[bunderstack] runWorker() cannot deliver realtime events through the in-memory broker',
    )
    expect(app.status).toBe('ready')
    await app.close()
  } finally {
    if (prevRedis !== undefined) process.env.REDIS_URL = prevRedis
    else delete process.env.REDIS_URL
  }
})

test('runWorker allows an explicit process-local realtime override', async () => {
  const prevRedis = process.env.REDIS_URL
  delete process.env.REDIS_URL
  try {
    const app = await createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter: libsql() },
      realtime: true,
      jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
    })
    await provision(app, { force: true })

    await expect(
      app.runWorker({
        signal: AbortSignal.abort(),
        pollIntervalMs: 1,
        allowProcessLocalRealtime: true,
      }),
    ).resolves.toBeUndefined()
    expect(app.status).toBe('closed')
  } finally {
    if (prevRedis !== undefined) process.env.REDIS_URL = prevRedis
    else delete process.env.REDIS_URL
  }
})

test('runWorker accepts configured redis realtime without throwing', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    realtime: { redis: 'redis://localhost:6379' },
    jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
  })
  await provision(app, { force: true })

  await expect(
    app.runWorker({
      signal: AbortSignal.abort(),
      pollIntervalMs: 1,
    }),
  ).resolves.toBeUndefined()
  expect(app.status).toBe('closed')
})
