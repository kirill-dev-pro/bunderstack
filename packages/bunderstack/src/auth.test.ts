// tests/auth.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createAuth } from './auth'
import { createDb } from './db'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('createAuth returns an object with a handler function', () => {
  const db = createDb({ posts }, { url: ':memory:' })
  const auth = createAuth(db, {
    emailAndPassword: { enabled: true },
    secret: 'test-secret-at-least-32-chars-long-x',
  })
  expect(typeof auth.handler).toBe('function')
})
