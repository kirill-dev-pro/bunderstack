// src/env.test.ts
import { test, expect } from 'bun:test'
import { z } from 'zod'

import { validateEnv, createClientEnv, BunderstackEnvError } from './env'

test('base schema applies dev defaults with empty source', () => {
  const env = validateEnv(undefined, { source: {} })
  expect(env.DATABASE_URL).toBe('file:./data.db')
  expect(env.AUTH_SECRET).toBe('dev-secret-change-in-prod')
  expect(env.REDIS_URL).toBeUndefined()
})

test('base schema reads values from source', () => {
  const env = validateEnv(undefined, {
    source: {
      DATABASE_URL: 'libsql://x.turso.io',
      DATABASE_AUTH_TOKEN: 'tok',
      AUTH_SECRET: 's3cret',
      REDIS_URL: 'redis://localhost',
    },
  })
  expect(env.DATABASE_URL).toBe('libsql://x.turso.io')
  expect(env.DATABASE_AUTH_TOKEN).toBe('tok')
  expect(env.AUTH_SECRET).toBe('s3cret')
  expect(env.REDIS_URL).toBe('redis://localhost')
})

test('AUTH_SECRET is required in production', () => {
  expect(() =>
    validateEnv(undefined, { source: { NODE_ENV: 'production' } }),
  ).toThrow(BunderstackEnvError)
  try {
    validateEnv(undefined, { source: { NODE_ENV: 'production' } })
  } catch (e) {
    expect((e as BunderstackEnvError).issues.join(' ')).toContain('AUTH_SECRET')
  }
})

test('RESEND_API_KEY required only when email provider is resend', () => {
  // not required without provider
  expect(() => validateEnv(undefined, { source: {} })).not.toThrow()
  // required with provider
  expect(() =>
    validateEnv(undefined, { source: {}, emailProvider: 'resend' }),
  ).toThrow(/RESEND_API_KEY/)
  // satisfied
  const env = validateEnv(undefined, {
    source: { RESEND_API_KEY: 're_123' },
    emailProvider: 'resend',
  })
  expect(env.RESEND_API_KEY).toBe('re_123')
})

test('SMTP_URL required only when email provider is smtp', () => {
  expect(() =>
    validateEnv(undefined, { source: {}, emailProvider: 'smtp' }),
  ).toThrow(/SMTP_URL/)
})

test('user server extension is validated and typed', () => {
  const env = validateEnv(
    { server: { OPENAI_API_KEY: z.string() } },
    { source: { OPENAI_API_KEY: 'sk-1' } },
  )
  const key: string = env.OPENAI_API_KEY
  expect(key).toBe('sk-1')
})

test('user client extension is validated and typed', () => {
  const env = validateEnv(
    { client: { PUBLIC_APP_URL: z.string().url() } },
    { source: { PUBLIC_APP_URL: 'https://app.example.com' } },
  )
  expect(env.PUBLIC_APP_URL).toBe('https://app.example.com')
})

test('all failures are aggregated into one error', () => {
  try {
    validateEnv(
      {
        server: { OPENAI_API_KEY: z.string() },
        client: { PUBLIC_APP_URL: z.string().url() },
      },
      { source: { PUBLIC_APP_URL: 'not-a-url' } },
    )
    expect.unreachable()
  } catch (e) {
    const err = e as BunderstackEnvError
    expect(err.issues).toHaveLength(2)
    expect(err.message).toContain('OPENAI_API_KEY')
    expect(err.message).toContain('PUBLIC_APP_URL')
  }
})

test('server keys must not start with PUBLIC_', () => {
  expect(() =>
    validateEnv(
      { server: { PUBLIC_LEAK: z.string() } },
      { source: { PUBLIC_LEAK: 'x' } },
    ),
  ).toThrow(/PUBLIC_/)
})

test('client keys must start with PUBLIC_', () => {
  expect(() =>
    validateEnv(
      { client: { APP_URL: z.string() } },
      { source: { APP_URL: 'x' } },
    ),
  ).toThrow(/PUBLIC_/)
})

test('optional user vars may be absent', () => {
  const env = validateEnv(
    { server: { FEATURE_FLAG: z.string().optional() } },
    { source: {} },
  )
  expect(env.FEATURE_FLAG).toBeUndefined()
})

test('createClientEnv validates client vars from runtimeEnv', () => {
  const env = createClientEnv({
    server: { SECRET_KEY: z.string() },
    client: { PUBLIC_APP_URL: z.string().url() },
    runtimeEnv: { PUBLIC_APP_URL: 'https://app.example.com' },
  })
  expect(env.PUBLIC_APP_URL).toBe('https://app.example.com')
})

test('createClientEnv throws on server key access', () => {
  const env = createClientEnv({
    server: { SECRET_KEY: z.string() },
    client: { PUBLIC_APP_URL: z.string() },
    runtimeEnv: { PUBLIC_APP_URL: 'x' },
  })
  expect(() => (env as Record<string, unknown>).SECRET_KEY).toThrow(
    /SECRET_KEY is server-only/,
  )
})

test('createClientEnv aggregates client validation failures', () => {
  expect(() =>
    createClientEnv({
      client: { PUBLIC_APP_URL: z.string().url() },
      runtimeEnv: { PUBLIC_APP_URL: 'not-a-url' },
    }),
  ).toThrow(BunderstackEnvError)
})

test('createClientEnv falls back to process.env', () => {
  process.env.PUBLIC_FROM_PROCESS = 'yes'
  const env = createClientEnv({ client: { PUBLIC_FROM_PROCESS: z.string() } })
  expect(env.PUBLIC_FROM_PROCESS).toBe('yes')
  delete process.env.PUBLIC_FROM_PROCESS
})
