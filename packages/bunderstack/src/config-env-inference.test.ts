import { expect, test } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { defineAuth } from './config'
import { libsql } from './database/libsql'
import { createBunderstack } from './index'

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

const schema = { user, notes }

const envSchema = {
  server: {
    STRIPE_KEY: v.optional(v.string(), 'sk_test'),
  },
  client: {
    PUBLIC_APP_NAME: v.optional(v.string(), 'Test'),
  },
}

const database = { adapter: libsql(), url: ':memory:' }

/**
 * `auth` accepts a factory whose context carries `env`. Unless that position is
 * shielded from inference, TypeScript reads a `TEnv` candidate from it and the
 * candidate from the `env` option is lost. `TEnv` then falls back to its
 * `undefined` default, and `env: envSchema` stops being assignable.
 */
test('env stays inferred when auth is a defineAuth factory', async () => {
  const authConfig = defineAuth(schema, ({ db }) => ({
    secret: 'test-secret',
    database: db ? undefined : undefined,
  }))

  const app = await createBunderstack({
    schema,
    env: envSchema,
    database,
    auth: authConfig,
  })

  // Compiles only when TEnv is inferred from `envSchema`.
  const key: string = app.env.STRIPE_KEY
  const name: string = app.env.PUBLIC_APP_NAME

  expect(key).toBe('sk_test')
  expect(name).toBe('Test')
  await app.close()
})

test('env stays inferred when auth is a plain object', async () => {
  const app = await createBunderstack({
    schema,
    env: envSchema,
    database,
    auth: { secret: 'test-secret' },
  })

  const key: string = app.env.STRIPE_KEY

  expect(key).toBe('sk_test')
  await app.close()
})
