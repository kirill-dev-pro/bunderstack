// src/app-env.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { libsql } from './database/libsql'
import { BunderstackEnvError } from './env'
import { createBunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('createBunderstack exposes typed app.env', async () => {
  process.env.MY_API_KEY = 'k-1'
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    env: { server: { MY_API_KEY: z.string() } },
  })
  const key: string = app.env.MY_API_KEY
  expect(key).toBe('k-1')
  expect(app.env.DATABASE_URL).toBe('file:./data.db')
  delete process.env.MY_API_KEY
})

test('createBunderstack refuses to boot on invalid env', async () => {
  await expect(
    createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter: libsql() },
      env: { server: { MISSING_REQUIRED: z.string() } },
    }),
  ).rejects.toThrow(BunderstackEnvError)
})

test('app.manifest describes the declaration', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    env: { server: { WEBHOOK_SECRET: z.string().optional() } },
    storage: {
      local: './tmp-manifest-uploads',
      buckets: { avatars: { visibility: 'public' } },
    },
  })
  expect(app.manifest.dialect).toBe('sqlite')
  expect(app.manifest.buckets).toEqual([
    { name: 'avatars', visibility: 'public' },
  ])
  expect(app.manifest.realtime).toBe(false)
  expect(app.manifest.env.server).toEqual([
    { key: 'WEBHOOK_SECRET', required: false },
  ])
})

test('BUNDERSTACK_INTROSPECT=1 boots offline despite remote url and missing env', async () => {
  process.env.BUNDERSTACK_INTROSPECT = '1'
  try {
    const app = await createBunderstack({
      schema: { notes },
      // Hardcoded remote URL must NOT be contacted during introspection.
      database: {
        url: 'libsql://nonexistent-introspect.turso.io',
        authToken: 'x',
        adapter: libsql(),
      },
      env: { server: { STRIPE_KEY: z.string() } }, // required and missing
      realtime: true, // must not require Redis
    })
    expect(app.manifest.env.server).toEqual([
      { key: 'STRIPE_KEY', required: true },
    ])
    expect(app.manifest.realtime).toBe(true)
  } finally {
    delete process.env.BUNDERSTACK_INTROSPECT
  }
})
