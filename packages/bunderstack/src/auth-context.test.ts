// src/auth-context.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { libsql } from './database/libsql'
import { bunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('auth builder receives the app database and validated env', async () => {
  let seen: { db: unknown; env: unknown } | undefined

  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    env: { server: { GREETING: v.optional(v.string(), 'hi') } },
    auth: (ctx) => {
      seen = ctx
      return { emailAndPassword: { enabled: true } }
    },
  }).start()

  // The whole point of the builder: hooks write through the app's own
  // connection instead of a second one opened by the application.
  expect(seen?.db).toBe(app.db)
  expect((seen?.env as { GREETING?: string })?.GREETING).toBe('hi')
  expect(app.auth.options.emailAndPassword?.enabled).toBe(true)

  await app.close()
})

test('auth builder output still gets the resolved secret and email defaults', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    email: { from: 'app@example.com' },
    auth: () => ({ emailAndPassword: { enabled: true } }),
  }).start()

  expect(typeof app.auth.options.secret).toBe('string')
  expect(typeof app.auth.options.emailAndPassword?.sendResetPassword).toBe(
    'function',
  )

  await app.close()
})

test('a plain auth object keeps working', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    auth: { emailAndPassword: { enabled: true } },
  }).start()

  expect(app.auth.options.emailAndPassword?.enabled).toBe(true)

  await app.close()
})
