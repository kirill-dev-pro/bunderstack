// tests/config.test.ts
import { test, expect } from 'bun:test'

import * as schema from '../../../examples/standalone/schema'
import { resolveConfig } from '../src/config'

test('resolveConfig applies SQLite default url', () => {
  const cfg = resolveConfig({ schema })
  expect(cfg.database.url).toBe('file:./data.db')
})

test('resolveConfig picks up DATABASE_URL env', () => {
  process.env.DATABASE_URL = 'libsql://test.turso.io'
  const cfg = resolveConfig({ schema })
  expect(cfg.database.url).toBe('libsql://test.turso.io')
  delete process.env.DATABASE_URL
})

test('resolveConfig defaults to local storage', () => {
  const cfg = resolveConfig({ schema })
  expect(cfg.storage.type).toBe('local')
  if (cfg.storage.type === 'local') {
    expect(cfg.storage.path).toBe('./uploads')
  }
})

test('resolveConfig accepts custom local path', () => {
  const cfg = resolveConfig({ schema, storage: { local: './my-uploads' } })
  expect(cfg.storage.type).toBe('local')
  if (cfg.storage.type === 'local') {
    expect(cfg.storage.path).toBe('./my-uploads')
  }
})

test('resolveConfig s3 true reads env vars', () => {
  process.env.S3_BUCKET = 'my-bucket'
  process.env.S3_REGION = 'eu-west-1'
  process.env.S3_ACCESS_KEY_ID = 'key'
  process.env.S3_SECRET_ACCESS_KEY = 'secret'
  const cfg = resolveConfig({ schema, storage: { s3: true } })
  expect(cfg.storage.type).toBe('s3')
  if (cfg.storage.type === 's3') {
    expect(cfg.storage.bucket).toBe('my-bucket')
    expect(cfg.storage.region).toBe('eu-west-1')
  }
  delete process.env.S3_BUCKET
  delete process.env.S3_REGION
  delete process.env.S3_ACCESS_KEY_ID
  delete process.env.S3_SECRET_ACCESS_KEY
})

test('resolveConfig auth defaults', () => {
  const cfg = resolveConfig({ schema })
  expect(typeof cfg.auth.secret).toBe('string')
})
