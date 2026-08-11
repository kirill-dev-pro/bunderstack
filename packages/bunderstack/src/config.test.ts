// tests/config.test.ts
import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { DatabaseAdapter } from './database/adapter'

import {
  resolveConfig,
  resolveRealtimeRedisUrl,
  type BunderstackConfig,
} from './config'
import { validateEnv } from './env'

const fakeAdapter = (dialect: 'sqlite' | 'pg' = 'sqlite'): DatabaseAdapter => ({
  dialect,
  driver: 'libsql',
  connect: async () => ({}) as never,
  migrate: async () => {},
})

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
})
const schema = { posts }

test('resolveConfig applies SQLite default url', () => {
  const cfg = resolveConfig({ schema, database: { adapter: fakeAdapter() } })
  expect(cfg.database.url).toBe('file:./data.db')
})

test('missing database.adapter rejects', () => {
  expect(() => resolveConfig({ schema } as any)).toThrow(
    '[bunderstack] database.adapter is required',
  )
})

test('BunderstackConfig requires database', () => {
  // @ts-expect-error database is required by the public config contract
  const invalidConfig: BunderstackConfig<typeof schema> = { schema }
  expect(invalidConfig.schema).toBe(schema)
})

test('resolveConfig picks up DATABASE_URL env', () => {
  process.env.DATABASE_URL = 'libsql://test.turso.io'
  const cfg = resolveConfig({ schema, database: { adapter: fakeAdapter() } })
  expect(cfg.database.url).toBe('libsql://test.turso.io')
  delete process.env.DATABASE_URL
})

test('resolveConfig defaults to a local default bucket', () => {
  const cfg = resolveConfig({ schema, database: { adapter: fakeAdapter() } })
  expect(cfg.storage.defaultBucket).toBe('default')
  const backend = cfg.storage.buckets.get('default')?.backend
  expect(backend?.type).toBe('local')
  if (backend?.type === 'local') {
    expect(backend.path).toBe('./uploads')
  }
})

test('resolveConfig accepts custom local path', () => {
  const cfg = resolveConfig({
    schema,
    database: { adapter: fakeAdapter() },
    storage: { local: './my-uploads' },
  })
  const backend = cfg.storage.buckets.get('default')?.backend
  expect(backend?.type).toBe('local')
  if (backend?.type === 'local') {
    expect(backend.path).toBe('./my-uploads')
  }
})

test('resolveConfig s3 true reads env vars', () => {
  process.env.S3_BUCKET = 'my-bucket'
  process.env.S3_REGION = 'eu-west-1'
  process.env.S3_ACCESS_KEY_ID = 'key'
  process.env.S3_SECRET_ACCESS_KEY = 'secret'
  const cfg = resolveConfig({
    schema,
    database: { adapter: fakeAdapter() },
    storage: { s3: true },
  })
  const backend = cfg.storage.buckets.get('default')?.backend
  expect(backend?.type).toBe('s3')
  if (backend?.type === 's3') {
    expect(backend.bucket).toBe('my-bucket')
    expect(backend.region).toBe('eu-west-1')
  }
  delete process.env.S3_BUCKET
  delete process.env.S3_REGION
  delete process.env.S3_ACCESS_KEY_ID
  delete process.env.S3_SECRET_ACCESS_KEY
})

test('resolveConfig auth defaults', () => {
  const cfg = resolveConfig({ schema, database: { adapter: fakeAdapter() } })
  expect(typeof cfg.auth.secret).toBe('string')
})

test('resolveConfig consumes a validated env for database url', () => {
  const env = validateEnv(undefined, {
    source: { DATABASE_URL: 'libsql://from-env.turso.io' },
  })
  const cfg = resolveConfig(
    { schema: {}, database: { adapter: fakeAdapter() } },
    env,
  )
  expect(cfg.database.url).toBe('libsql://from-env.turso.io')
})

test('explicit config wins over env', () => {
  const env = validateEnv(undefined, {
    source: { DATABASE_URL: 'libsql://from-env.turso.io' },
  })
  const cfg = resolveConfig(
    {
      schema: {},
      database: { adapter: fakeAdapter(), url: 'file:./explicit.db' },
    },
    env,
  )
  expect(cfg.database.url).toBe('file:./explicit.db')
})

test('resolveConfig auth secret comes from validated env', () => {
  const env = validateEnv(undefined, { source: { AUTH_SECRET: 'from-env' } })
  const cfg = resolveConfig(
    { schema: {}, database: { adapter: fakeAdapter() } },
    env,
  )
  expect(cfg.auth.secret).toBe('from-env')
})

test('BUNDERSTACK_DATABASE_URL overrides code-level database config', () => {
  const cfg = resolveConfig(
    {
      schema,
      database: {
        adapter: fakeAdapter(),
        url: 'file:./hardcoded.db',
        authToken: 'code-token',
      },
    },
    undefined,
    {
      BUNDERSTACK_DATABASE_URL: 'libsql://prod-app.turso.io',
      BUNDERSTACK_DATABASE_AUTH_TOKEN: 'platform-token',
    },
  )
  expect(cfg.database.url).toBe('libsql://prod-app.turso.io')
  expect(cfg.database.authToken).toBe('platform-token')
})

test('without platform vars, code-level database config still wins over env', () => {
  const cfg = resolveConfig(
    {
      schema,
      database: { adapter: fakeAdapter(), url: 'file:./hardcoded.db' },
    },
    undefined,
    {},
  )
  expect(cfg.database.url).toBe('file:./hardcoded.db')
})

test('resolveRealtimeRedisUrl precedence: platformSource > env > code config > undefined', () => {
  const codeRealtime = { redis: 'redis://code-level' }
  const envWithRedis = validateEnv(undefined, {
    source: { REDIS_URL: 'redis://env-level' },
  })

  // 1. platformSource.REDIS_URL beats everything
  expect(
    resolveRealtimeRedisUrl(codeRealtime, envWithRedis, {
      REDIS_URL: 'redis://platform-level',
    }),
  ).toBe('redis://platform-level')

  // 2. env.REDIS_URL beats code-level realtime.redis when platformSource is empty
  expect(resolveRealtimeRedisUrl(codeRealtime, envWithRedis, {})).toBe(
    'redis://env-level',
  )

  // 3. realtime.redis used when neither platformSource nor env has REDIS_URL
  expect(resolveRealtimeRedisUrl(codeRealtime, undefined, {})).toBe(
    'redis://code-level',
  )

  // 4. undefined when no REDIS_URL or realtime.redis exists
  expect(resolveRealtimeRedisUrl(undefined, undefined, {})).toBe(undefined)
})

test('Bunderhost-injected REDIS_URL overrides hardcoded application Redis URL', () => {
  const codeRealtime = { redis: { url: 'redis://app-hardcoded:6379' } }

  const resolved = resolveRealtimeRedisUrl(codeRealtime, undefined, {
    REDIS_URL: 'redis://bunderhost-injected:6379',
  })

  expect(resolved).toBe('redis://bunderhost-injected:6379')
})

test('resolveConfig still reads database overrides from options', () => {
  const resolved = resolveConfig(
    {
      schema: {},
      database: {
        adapter: { dialect: 'sqlite' } as never,
        url: 'file:./explicit.db',
        authToken: 'tok',
        migrations: './custom-migrations',
      },
    } as never,
    { DATABASE_URL: 'file:./ignored.db' } as never,
    {},
  )
  expect(resolved.database.url).toBe('file:./explicit.db')
  expect(resolved.database.authToken).toBe('tok')
  expect(resolved.database.migrations).toBe('./custom-migrations')
})

test('resolveConfig still passes realtime through', () => {
  const resolved = resolveConfig(
    {
      schema: {},
      database: { adapter: { dialect: 'sqlite' } as never },
      realtime: { resumeSeconds: 300, redis: 'redis://localhost:6379' },
    } as never,
    { DATABASE_URL: 'file::memory:' } as never,
    {},
  )
  expect(resolved.realtime).toEqual({
    resumeSeconds: 300,
    redis: 'redis://localhost:6379',
  })
})

test('a malformed realtime option still throws', () => {
  expect(() =>
    resolveConfig(
      {
        schema: {},
        database: { adapter: { dialect: 'sqlite' } as never },
        realtime: { resumeSeconds: 'soon' },
      } as never,
      { DATABASE_URL: 'file::memory:' } as never,
      {},
    ),
  ).toThrow()
})

test('a malformed rateLimit option still throws', () => {
  expect(() =>
    resolveConfig(
      {
        schema: {},
        database: { adapter: { dialect: 'sqlite' } as never },
        rateLimit: { max: 'lots' },
      } as never,
      { DATABASE_URL: 'file::memory:' } as never,
      {},
    ),
  ).toThrow()
})

test('BunderstackOptionsSchema is no longer exported', async () => {
  const mod = await import('./config')
  expect('BunderstackOptionsSchema' in mod).toBe(false)
})
