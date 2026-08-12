import { test, expect, beforeAll } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  userId: text('user_id'),
  likes: integer('likes').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

/** No filterable columns — the sync client still sends `filters: {}`. */
const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
})

const schema = { user, session, account, verification, posts, tags }

type ListBody = {
  items: { id: number; title: string; userId: string | null; likes: number }[]
  total?: number
  offset?: number
  limit?: number
}

const createApp = () =>
  createBunderstack({
    schema,
    database: { url: ':memory:', adapter: libsql() },
    auth: {},
    access: {
      posts: {
        list: 'public',
        get: 'public',
        create: 'public',
        filterableColumns: ['userId', 'likes', 'createdAt'],
        sortableColumns: ['id', 'likes'],
        defaultSort: { column: 'id', order: 'asc' },
      },
      tags: { crud: true, list: 'public' },
    },
  })

let app: Awaited<ReturnType<typeof createApp>>

beforeAll(async () => {
  app = await createApp()
  await provision(app, { force: true })

  await app.db.insert(posts).values([
    { title: 'a', userId: 'u1', likes: 1, createdAt: new Date('2026-01-01') },
    { title: 'b', userId: 'u2', likes: 5, createdAt: new Date('2026-06-01') },
    { title: 'c', userId: null, likes: 9, createdAt: null },
  ])
})

const rest = async (path: string) => {
  const res = await app.handler(new Request(`http://localhost${path}`))
  return { status: res.status, body: (await res.json()) as ListBody }
}

const rpc = async (procedure: string, input: unknown) => {
  const res = await app.handler(
    new Request(`http://localhost/api/rpc/${procedure}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: input }),
    }),
  )
  const payload = (await res.json()) as { json?: ListBody }
  return { status: res.status, body: payload.json as ListBody }
}

const titles = (body: ListBody) => body.items.map((item) => item.title).sort()

test('REST offset paginates instead of failing validation', async () => {
  const { status, body } = await rest('/api/posts?offset=1&limit=1')
  expect(status).toBe(200)
  expect(body.offset).toBe(1)
  expect(titles(body)).toEqual(['b'])
})

test('REST count=true returns the total', async () => {
  const { status, body } = await rest('/api/posts?count=true')
  expect(status).toBe(200)
  expect(body.total).toBe(3)
})

test('REST filters a column through the nested filters param', async () => {
  const { status, body } = await rest('/api/posts?filters[userId]=u1')
  expect(status).toBe(200)
  expect(titles(body)).toEqual(['a'])
})

test('REST filters by a list of values', async () => {
  const { status, body } = await rest(
    '/api/posts?filters[userId][]=u1&filters[userId][]=u2',
  )
  expect(status).toBe(200)
  expect(titles(body)).toEqual(['a', 'b'])
})

test('REST filters for a null column value', async () => {
  const { status, body } = await rest('/api/posts?filters[userId]=null')
  expect(status).toBe(200)
  expect(titles(body)).toEqual(['c'])
})

test('REST coerces a numeric filter to the column type', async () => {
  const { status, body } = await rest('/api/posts?filters[likes]=5')
  expect(status).toBe(200)
  expect(titles(body)).toEqual(['b'])
})

test('REST coerces a date filter to the column type', async () => {
  const { status, body } = await rest('/api/posts?filters[createdAt]=2026-06-01')
  expect(status).toBe(200)
  expect(titles(body)).toEqual(['b'])
})

test('REST rejects a filter column that is not allowed', async () => {
  const { status } = await rest('/api/posts?filters[title]=a')
  expect(status).toBe(400)
})

test('REST rejects a filter value the column type cannot hold', async () => {
  const { status } = await rest('/api/posts?filters[likes]=many')
  expect(status).toBe(400)
})

test('REST rejects an unknown query parameter', async () => {
  const { status } = await rest('/api/posts?utm_source=newsletter')
  expect(status).toBe(400)
})

test('RPC and REST agree on the same filter', async () => {
  const viaRpc = await rpc('posts/list', { filters: { userId: 'u1' } })
  const viaRest = await rest('/api/posts?filters[userId]=u1')
  expect(viaRpc.status).toBe(200)
  expect(titles(viaRpc.body)).toEqual(titles(viaRest.body))
})

test('RPC accepts typed filter values', async () => {
  const list = await rpc('posts/list', {
    filters: { likes: [1, 9] },
    sort: 'likes',
    order: 'desc',
  })
  expect(list.status).toBe(200)
  expect(list.body.items.map((item) => item.likes)).toEqual([9, 1])
})

test('RPC accepts a real null filter value', async () => {
  const list = await rpc('posts/list', { filters: { userId: null } })
  expect(list.status).toBe(200)
  expect(titles(list.body)).toEqual(['c'])
})

test('a table without filterable columns still accepts an empty filters object', async () => {
  const list = await rpc('tags/list', { filters: {} })
  expect(list.status).toBe(200)
  expect(list.body.items).toEqual([])
})

test('a request URL can no longer smuggle filters past the schema', async () => {
  // `userId` is filterable, but only through `filters` — a bare query param is
  // not part of the contract and must not reach the WHERE clause.
  const { status } = await rest('/api/posts?userId=u1')
  expect(status).toBe(400)
})

test('a column named like a list parameter can still be filtered and sorted', async () => {
  // Nesting filters means `limit` as a column name no longer collides with
  // `?limit=`, so the config that used to be rejected must now work.
  const plans = sqliteTable('plans', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    limit: integer('limit').notNull(),
  })
  const planSchema = { user, session, account, verification, plans }
  const planApp = await createBunderstack({
    schema: planSchema,
    database: { url: ':memory:', adapter: libsql() },
    auth: {},
    access: {
      plans: {
        crud: true,
        list: 'public',
        filterableColumns: ['limit'],
        sortableColumns: ['id', 'limit'],
      },
    },
  })
  await provision(planApp, { force: true })
  await planApp.db.insert(plans).values([{ limit: 10 }, { limit: 20 }])

  const res = await planApp.handler(
    new Request('http://localhost/api/plans?filters[limit]=20&limit=1'),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: { limit: number }[] }
  expect(body.items.map((item) => item.limit)).toEqual([20])
  await planApp.close()
})
