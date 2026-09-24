// tests/auth.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createAuth, lazyAuth } from './auth'
import { libsql } from './database/libsql'
import { createDb } from './db'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('createAuth returns an object with a handler function', async () => {
  const { db } = await createDb(
    { posts },
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  )
  const auth = createAuth(
    db,
    {
      emailAndPassword: { enabled: true },
      secret: 'test-secret-at-least-32-chars-long-x',
    },
    'sqlite',
  )
  expect(typeof auth.handler).toBe('function')
})

test('lazyAuth builds the instance on first access, once', () => {
  let builds = 0
  const auth = lazyAuth(() => {
    builds += 1
    return { handler: () => 'ok', api: {} }
  })
  const ctx = ({ auth })
  expect(builds).toBe(0)
  expect(ctx.auth.handler()).toBe('ok')
  expect('api' in auth).toBe(true)
  expect(builds).toBe(1)
})
