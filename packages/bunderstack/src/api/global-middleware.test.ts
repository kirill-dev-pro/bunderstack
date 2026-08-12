import { beforeAll, expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'
import { defineApi } from './builder'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
})

const schema = { notes }

const o = defineApi({ schema })

const paths: string[][] = []

const record = o.middleware(async ({ path, next }) => {
  paths.push(path)
  return next()
})

let app: Awaited<ReturnType<typeof createApp>>

const createApp = () =>
  createBunderstack({
    schema,
    database: { url: ':memory:', adapter: libsql() },
    access: { notes: { list: 'public', get: 'public' } },
    middleware: [record],
    api: {
      ping: o.public
        .route({ method: 'GET', path: '/api/ping' })
        .handler(() => ({ pong: true })),
    },
  })

beforeAll(async () => {
  app = await createApp()
  await provision(app, { force: true })
})

test('a configured middleware runs for a custom procedure', async () => {
  paths.length = 0

  const response = await app.handler(new Request('http://test/api/ping'))

  expect(response.status).toBe(200)
  expect(paths).toContainEqual(['ping'])
})

test('a configured middleware runs for a generated CRUD procedure', async () => {
  paths.length = 0

  const response = await app.handler(new Request('http://test/api/notes'))

  expect(response.status).toBe(200)
  expect(paths).toContainEqual(['notes', 'list'])
})

test('a configured middleware runs for the health procedure', async () => {
  paths.length = 0

  const response = await app.handler(new Request('http://test/api/health'))

  expect(response.status).toBe(200)
  expect(paths).toContainEqual(['health'])
})

test('a configured middleware does not resolve the session', async () => {
  const seen: string[] = []
  let authCalls = 0
  const raw = '{"event":"created"}'

  const peek = o.middleware(async ({ context, next }) => {
    const result = await next()
    seen.push(context.peekSession()?.user?.id ?? 'unresolved')
    return result
  })

  const webhookApp = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    authResolver: {
      api: {
        getSession: async () => {
          authCalls++
          return null
        },
      },
    },
    middleware: [peek],
    api: {
      hook: o.webhook
        .route({ method: 'POST', path: '/webhooks/demo' })
        .handler(async ({ context }) => ({
          raw: await context.getRawBody(),
        })),
    },
  })

  const response = await webhookApp.handler(
    new Request('http://test/webhooks/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    }),
  )

  expect(response.status).toBe(200)
  expect(seen).toEqual(['unresolved'])
  expect(authCalls).toBe(0)
  await webhookApp.close()
})
