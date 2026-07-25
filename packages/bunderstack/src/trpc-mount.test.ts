// src/trpc-mount.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { libsql } from './database/libsql'
import { createBunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }),
})

let app: Awaited<ReturnType<typeof buildApp>>

function buildApp() {
  return createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    env: { server: { GREETING: z.string().optional() } },
    trpc: (t) =>
      t.router({
        hello: t.procedure
          .input(z.object({ name: z.string() }))
          .query(({ input, ctx }) => ({
            // ctx.db / ctx.env are typed from the sibling config keys
            greeting: `${ctx.env.GREETING ?? 'hi'} ${input.name}`,
            at: new Date('2026-01-02T03:04:05Z'),
          })),
        secret: t.protectedProcedure.query(({ ctx }) => ({ id: ctx.user.id })),
      }),
  })
}

beforeAll(async () => {
  app = await buildApp()
})

function trpcUrl(path: string, input?: unknown) {
  const q =
    input === undefined
      ? ''
      : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  return `http://test/api/trpc/${path}${q}`
}

test('query procedure is served under /api/trpc', async () => {
  const res = await app.handler(new Request(trpcUrl('hello', { name: 'bun' })))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    result: { data: { json: { greeting: string }; meta?: unknown } }
  }
  expect(body.result.data.json.greeting).toBe('hi bun')
  // superjson meta marks the Date field
  expect(JSON.stringify(body.result.data.meta ?? {})).toContain('Date')
})

test('invalid input returns tRPC BAD_REQUEST', async () => {
  const res = await app.handler(new Request(trpcUrl('hello', { name: 42 })))
  expect(res.status).toBe(400)
})

test('protected procedure returns 401 without a session', async () => {
  const res = await app.handler(new Request(trpcUrl('secret')))
  expect(res.status).toBe(401)
})

test('unknown procedure 404s', async () => {
  const res = await app.handler(new Request(trpcUrl('nope')))
  expect(res.status).toBe(404)
})

test('prebuilt router escape hatch works', async () => {
  const { createTRPC } = await import('./trpc')
  const t = createTRPC<{ notes: typeof notes }>()
  const router = t.router({ ping: t.procedure.query(() => 'pong') })
  const prebuilt = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    trpc: router,
  })
  const res = await prebuilt.handler(new Request(trpcUrl('ping')))
  expect(res.status).toBe(200)
})

test('$inferClient carries the router type', () => {
  // Type-level: the carrier's trpc field is the router, not undefined.
  type Carrier = NonNullable<(typeof app)['$inferClient']>
  type HasTrpc = Carrier extends { trpc: infer R }
    ? R extends undefined
      ? false
      : true
    : false
  const check: HasTrpc = true
  expect(check).toBe(true)
})
