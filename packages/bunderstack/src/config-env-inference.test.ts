import { expect, test } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { EmailMessage, SentEmail } from './email'
import type { RealtimeFacade } from './realtime/facade'

import { defineAuth } from './config'
import { libsql } from './database/libsql'
import { bunderstack, resend } from './index'

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

  const app = await bunderstack({ schema, env: envSchema }, () => ({
    database,
    auth: authConfig,
  })).start()

  // Compiles only when TEnv is inferred from `envSchema`.
  const key: string = app.env.STRIPE_KEY
  const name: string = app.env.PUBLIC_APP_NAME

  expect(key).toBe('sk_test')
  expect(name).toBe('Test')
  await app.close()
})

test('env stays inferred when auth is a plain object', async () => {
  const app = await bunderstack({ schema, env: envSchema }, () => ({
    database,
    auth: { secret: 'test-secret' },
  })).start()

  const key: string = app.env.STRIPE_KEY

  expect(key).toBe('sk_test')
  await app.close()
})

test('env-first declaration callback is inferred from its schema', async () => {
  const backend = bunderstack({ schema, env: envSchema }, (env) => {
    const key: string = env.STRIPE_KEY
    const name: string = env.PUBLIC_APP_NAME
    return {
      database,
      auth: { secret: `${key}:${name}` },
    }
  })

  const app = await backend.start({
    env: { DATABASE_URL: ':memory:' },
  })
  expect(app.env.STRIPE_KEY).toBe('sk_test')
  expect(app.env.PUBLIC_APP_NAME).toBe('Test')
  await app.close()
})

/**
 * A factory that names its `env` parameter is context-sensitive, and so is an
 * inline `jobs` or `api` builder. TypeScript gives up on a type parameter that
 * a nested context-sensitive callback names, so the declaration keeps `schema`
 * and `env` in its first argument and keeps `TMessaging` out of the builder
 * parameters. This test fails to compile if either rule is broken.
 */
test('declarations keep their inference beside inline builders', async () => {
  const backend = bunderstack({ schema, env: envSchema }, (env) => ({
    database,
    access: { notes: { crud: true, list: 'public' } },
    realtime: true,
    messaging: { email: resend({ from: `noreply@${env.PUBLIC_APP_NAME}` }) },
    jobs: (j) =>
      j.define({
        beat: j.job({
          input: v.object({}),
          handler: async (_input, ctx) => {
            // Exact table types survive inside an inline builder.
            await ctx.db.select().from(notes)
          },
        }),
      }),
  }))

  const app = await backend.start({ env: { DATABASE_URL: ':memory:' } })
  // Compiles only when the channel record and the realtime flag are inferred.
  const send: (message: EmailMessage) => Promise<SentEmail> =
    app.messaging.email.send
  const realtime: RealtimeFacade<typeof schema> = app.realtime
  expect(typeof send).toBe('function')
  expect(realtime).toBeDefined()
  await app.close()
})
