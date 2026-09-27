// src/app-env.test.ts
import { test, expect } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { DatabaseAdapter } from './database/adapter'

import { libsql } from './database/libsql'
import { BunderstackEnvError } from './env'
import { bunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

test('bunderstack exposes typed app.env', async () => {
  process.env.MY_API_KEY = 'k-1'
  const app = await bunderstack({
    schema: { notes },
    env: { server: { MY_API_KEY: v.string() } },
    database: { url: ':memory:', adapter: libsql() },
  }).start()
  const key: string = app.env.MY_API_KEY
  expect(key).toBe('k-1')
  expect(app.env.DATABASE_URL).toBe('file:./data.db')
  delete process.env.MY_API_KEY
})

test('bunderstack refuses to boot on invalid env', async () => {
  await expect(
    bunderstack({
      schema: { notes },
      env: { server: { MISSING_REQUIRED: v.string() } },
      database: { url: ':memory:', adapter: libsql() },
    }).start(),
  ).rejects.toThrow(BunderstackEnvError)
})

test('app.close closes the database exactly once', async () => {
  let closeCount = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect(schema) {
      return {
        db: drizzle.mock({ schema }) as never,
        close: () => {
          closeCount += 1
        },
      }
    },
    async migrate() {},
  }
  const app = await bunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter },
  }).start()

  await app.close()
  expect(closeCount).toBe(1)
  await app.close()
  expect(closeCount).toBe(1)
})

test('initialization failure closes the database and preserves the cause', async () => {
  let closeCount = 0
  const initializationError = new Error('API initialization failed')
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect(schema) {
      return {
        db: drizzle.mock({ schema }) as never,
        close: () => {
          closeCount += 1
        },
      }
    },
    async migrate() {},
  }

  let caught: unknown
  try {
    await bunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter },
      // The auth factory runs inside runtime init, after the database is
      // connected, so a throw here exercises the cleanup path.
      auth: () => {
        throw initializationError
      },
    }).start()
  } catch (cause) {
    caught = cause
  }

  expect(caught).toBe(initializationError)
  expect(closeCount).toBe(1)
})

test('initialization and cleanup failures are preserved in an AggregateError', async () => {
  let closeCount = 0
  const initializationError = new Error('API initialization failed')
  const cleanupError = new Error('database cleanup failed')
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect(schema) {
      return {
        db: drizzle.mock({ schema }) as never,
        close: async () => {
          closeCount += 1
          throw cleanupError
        },
      }
    },
    async migrate() {},
  }

  let caught: unknown
  try {
    await bunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter },
      // The auth factory runs inside runtime init, after the database is
      // connected, so a throw here exercises the cleanup path.
      auth: () => {
        throw initializationError
      },
    }).start()
  } catch (cause) {
    caught = cause
  }

  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).message).toBe(
    '[bunderstack] application initialization failed and cleanup failed',
  )
  const errors = (caught as AggregateError).errors
  expect(errors[0]).toBe(initializationError)
  expect(errors[1]).toBeInstanceOf(AggregateError)
  expect((errors[1] as AggregateError).errors).toEqual([cleanupError])
  expect(closeCount).toBe(1)
})

test('backend.inspect describes the declaration', () => {
  const backend = bunderstack({
    schema: { notes },
    env: { server: { WEBHOOK_SECRET: v.optional(v.string()) } },
    database: { url: ':memory:', adapter: libsql() },
    storage: {
      local: './tmp-manifest-uploads',
      buckets: { avatars: { visibility: 'public' } },
    },
  })
  const manifest = backend.inspect({ env: {} })
  expect(manifest.database.dialect).toBe('sqlite')
  expect(manifest.storage.buckets).toEqual([
    { name: 'avatars', visibility: 'public' },
  ])
  expect(manifest.realtime).toEqual({ required: false })
  expect(manifest.environment).toEqual([
    {
      key: 'WEBHOOK_SECRET',
      required: false,
      scope: 'server',
      sensitive: true,
    },
  ])
})

test('start env feeds platform overrides as well as env vars', async () => {
  const app = await bunderstack({
    schema: {},
    database: { adapter: libsql() },
  } as never).start({
    env: {
      DATABASE_URL: 'file::memory:',
      BUNDERSTACK_DATABASE_URL: 'file::memory:',
      BUNDERSTACK_REVISION: 'r1',
    },
  })
  expect(app.env.BUNDERSTACK_REVISION).toBe('r1')
  await app.close()
})

test('envSource is no longer accepted', async () => {
  const app = await bunderstack({
    schema: {},
    database: { adapter: libsql() },
    envSource: { BUNDERSTACK_REVISION: 'from-env-source' },
  } as never).start({ env: { DATABASE_URL: 'file::memory:' } })
  // envSource is ignored entirely.
  expect(app.env.BUNDERSTACK_REVISION).toBeUndefined()
  await app.close()
})
