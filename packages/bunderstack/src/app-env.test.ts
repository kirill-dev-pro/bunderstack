// src/app-env.test.ts
import { test, expect } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { DatabaseAdapter } from './database/adapter'
import type { BunderstackJobsBuilder } from './jobs/define'

import { bunSql } from './database/bun-sql'
import { libsql } from './database/libsql'
import { BunderstackEnvError } from './env'
import { createBunderstack } from './index'

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})

const pgNotes = pgTable('notes', {
  id: pgText('id').primaryKey(),
})

test('createBunderstack exposes typed app.env', async () => {
  process.env.MY_API_KEY = 'k-1'
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    env: { server: { MY_API_KEY: v.string() } },
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
      env: { server: { MISSING_REQUIRED: v.string() } },
    }),
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
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter },
  })

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
    await createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter },
      api: () => {
        throw initializationError
      },
    })
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
    await createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter },
      api: () => {
        throw initializationError
      },
    })
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

test('app.manifest describes the declaration', async () => {
  const app = await createBunderstack({
    schema: { notes },
    database: { url: ':memory:', adapter: libsql() },
    env: { server: { WEBHOOK_SECRET: v.optional(v.string()) } },
    storage: {
      local: './tmp-manifest-uploads',
      buckets: { avatars: { visibility: 'public' } },
    },
  })
  expect(app.manifest.database.dialect).toBe('sqlite')
  expect(app.manifest.storage.buckets).toEqual([
    { name: 'avatars', visibility: 'public' },
  ])
  expect(app.manifest.realtime).toEqual({ required: false })
  expect(app.manifest.environment).toEqual([
    { key: 'WEBHOOK_SECRET', required: false, scope: 'server' },
  ])
})

test('server database introspection stays offline', async () => {
  const previous = process.env.BUNDERSTACK_INTROSPECT
  process.env.BUNDERSTACK_INTROSPECT = '1'

  try {
    const app = await createBunderstack({
      schema: { pgNotes },
      database: {
        adapter: bunSql(),
        url: 'postgres://example.invalid/app',
      },
    })

    expect(app.manifest).toBeDefined()
    expect(typeof (app.db as unknown as { $client: unknown }).$client).toBe(
      'object',
    )
    await app.close()
  } finally {
    if (previous === undefined) delete process.env.BUNDERSTACK_INTROSPECT
    else process.env.BUNDERSTACK_INTROSPECT = previous
  }
})

test('BUNDERSTACK_INTROSPECT=1 boots offline despite missing env and reports realtime requirements', async () => {
  const previous = process.env.BUNDERSTACK_INTROSPECT
  const prevRedis = process.env.REDIS_URL
  process.env.BUNDERSTACK_INTROSPECT = '1'
  delete process.env.REDIS_URL
  try {
    const app = await createBunderstack({
      schema: { notes },
      database: { url: ':memory:', adapter: libsql() },
      env: { server: { STRIPE_KEY: v.string() } },
      realtime: true,
    })
    expect(app.manifest.environment).toEqual([
      { key: 'STRIPE_KEY', required: true, scope: 'server' },
    ])
    expect(app.manifest.realtime).toEqual({ required: true })
  } finally {
    if (previous === undefined) delete process.env.BUNDERSTACK_INTROSPECT
    else process.env.BUNDERSTACK_INTROSPECT = previous
    if (prevRedis === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = prevRedis
  }
})

test('role=all starts the background loop', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    env: undefined,
    jobs: (j: BunderstackJobsBuilder<Record<string, never>>) => j.define({ beat: j.cron({ schedule: '* * * * *', handler: () => {} }) }),
    processEnv: { DATABASE_URL: ':memory:', BUNDERSTACK_ROLE: 'all' },
  } as never)
  expect(app.backgroundRunning).toBe(true)
  await app.close()
})

test('role=web does not start the background loop', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j: BunderstackJobsBuilder<Record<string, never>>) => j.define({ beat: j.cron({ schedule: '* * * * *', handler: () => {} }) }),
    processEnv: { DATABASE_URL: ':memory:', BUNDERSTACK_ROLE: 'web' },
  } as never)
  expect(app.backgroundRunning).toBe(false)
  await app.close()
})

test('background.autoStart false wins over role=all', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    jobs: (j: BunderstackJobsBuilder<Record<string, never>>) => j.define({ beat: j.cron({ schedule: '* * * * *', handler: () => {} }) }),
    background: { autoStart: false },
    processEnv: { DATABASE_URL: ':memory:', BUNDERSTACK_ROLE: 'all' },
  } as never)
  expect(app.backgroundRunning).toBe(false)
  await app.close()
})

test('processEnv feeds platform overrides as well as env vars', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    processEnv: {
      DATABASE_URL: 'file::memory:',
      BUNDERSTACK_DATABASE_URL: 'file::memory:',
      BUNDERSTACK_ROLE: 'web',
    },
  } as never)
  expect(app.env.BUNDERSTACK_ROLE).toBe('web')
  await app.close()
})

test('envSource is no longer accepted', async () => {
  const app = await createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    envSource: { BUNDERSTACK_ROLE: 'worker' },
    processEnv: { DATABASE_URL: 'file::memory:' },
  } as never)
  // envSource is ignored entirely; the role falls back to its default.
  expect(app.env.BUNDERSTACK_ROLE).toBe('all')
  await app.close()
})
