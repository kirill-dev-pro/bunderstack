// src/app-env.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createBunderstack } from './index'
import { BunderstackEnvError } from './env'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('createBunderstack exposes typed app.env', () => {
  process.env.MY_API_KEY = 'k-1'
  const app = createBunderstack({
    schema: { notes },
    database: { url: ':memory:' },
    env: { server: { MY_API_KEY: z.string() } },
  })
  const key: string = app.env.MY_API_KEY
  expect(key).toBe('k-1')
  expect(app.env.DATABASE_URL).toBe('file:./data.db')
  delete process.env.MY_API_KEY
})

test('createBunderstack refuses to boot on invalid env', () => {
  expect(() =>
    createBunderstack({
      schema: { notes },
      database: { url: ':memory:' },
      env: { server: { MISSING_REQUIRED: z.string() } },
    }),
  ).toThrow(BunderstackEnvError)
})
