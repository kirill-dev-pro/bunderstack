import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { createBunderstack } from '../index'
import { provision } from '../provision'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
})

test('app.jobs enqueues without implicit execution and explicit worker runs the handler', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
    jobs: (j) =>
      j.define({
        writeNote: j.job({
          input: z.object({ id: z.string(), body: z.string() }),
          handler: async (input, ctx) => {
            await ctx.db.insert(notes).values({ id: input.id, body: input.body })
          },
        }),
      }),
  })
  await provision(app, { force: true })

  await app.jobs.enqueue('writeNote', { id: 'n1', body: 'from a job' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await app.db.select().from(notes).where(eq(notes.id, 'n1'))).toEqual([])

  const worker = await app.startWorker({ pollIntervalMs: 1 })
  let rows: { body: string }[] = []
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    rows = await app.db.select().from(notes).where(eq(notes.id, 'n1'))
    if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
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
    database: { url: ':memory:' },
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

test('an app without jobs still has a facade; enqueue throws', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
  })
  await expect(
    (
      app.jobs as unknown as { enqueue: (n: string) => Promise<unknown> }
    ).enqueue('x'),
  ).rejects.toThrow(/no jobs configured/)
  await app.jobs.tick() // no-op, must not throw
})

test('introspection mode boots with jobs configured', async () => {
  process.env.BUNDERSTACK_INTROSPECT = '1'
  try {
    const app = await createBunderstack({
      schema: { notes },
      database: { url: ':memory:' },
      jobs: (j) => j.define({ noop: j.job({ handler: async () => {} }) }),
    })
    expect(app.manifest).toBeDefined()
  } finally {
    delete process.env.BUNDERSTACK_INTROSPECT
  }
})
