import { test, expect, beforeAll } from 'bun:test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

import { libsql } from './database/libsql'
import { createBunderstack } from './index'
import { provision } from './provision'

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

let app: Awaited<ReturnType<typeof createBunderstack<typeof schema>>>

beforeAll(async () => {
  app = await createBunderstack({
    schema,
    database: { url: ':memory:', adapter: libsql() },
    auth: {},
  })
  await provision(app, { force: true })
})

test('auth tables are not exposed via auto-CRUD', async () => {
  const res = await app.handler(new Request('http://localhost/api/user'))
  expect(res.status).toBe(404)
})

test('posts CRUD is available with userId convention', async () => {
  const res = await app.handler(
    new Request('http://localhost/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    }),
  )
  expect(res.status).toBe(201)
})
