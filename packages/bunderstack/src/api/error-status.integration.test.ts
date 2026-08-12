import { test, expect, beforeAll } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  userId: text('user_id'),
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

const schema = { user, session, account, verification, posts }

const createApp = () =>
  createBunderstack({
    schema,
    database: { url: ':memory:', adapter: libsql() },
    auth: {},
    access: {
      posts: {
        list: 'public',
        get: 'public',
        create: 'authenticated',
        filterableColumns: ['userId'],
        sortableColumns: ['id'],
      },
    },
  })

let app: Awaited<ReturnType<typeof createApp>>

beforeAll(async () => {
  app = await createApp()
  await provision(app, { force: true })
})

const rest = (path: string) => app.handler(new Request(`http://localhost${path}`))

const rpc = (procedure: string, input: unknown) =>
  app.handler(
    new Request(`http://localhost/api/rpc/${procedure}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: input }),
    }),
  )

test('REST input that no schema accepts answers 400, not 500', async () => {
  const res = await rest('/api/posts?limit=abc')
  expect(res.status).toBe(400)
})

test('RPC input that no schema accepts answers 400, not 500', async () => {
  const res = await rpc('posts/list', { limit: 'abc' })
  expect(res.status).toBe(400)
})

test('RPC rejects a disallowed sort column with 400, not 500', async () => {
  const res = await rpc('posts/list', { sort: 'title' })
  expect(res.status).toBe(400)
})

test('REST rejects a disallowed sort column with 400', async () => {
  const res = await rest('/api/posts?sort=title')
  expect(res.status).toBe(400)
})

test('a missing row answers 404 over both protocols', async () => {
  expect((await rest('/api/posts/9999')).status).toBe(404)
  expect((await rpc('posts/get', { id: '9999' })).status).toBe(404)
})

test('an unauthenticated write answers 401 over both protocols', async () => {
  const restRes = await app.handler(
    new Request('http://localhost/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    }),
  )
  expect(restRes.status).toBe(401)
  expect((await rpc('posts/create', { title: 'nope' })).status).toBe(401)
})
