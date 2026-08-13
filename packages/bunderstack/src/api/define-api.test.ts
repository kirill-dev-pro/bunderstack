import { createProcedureClient } from '@orpc/server'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { defineApi } from './builder'
import { createApiContext } from './context'

const todos = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const schema = { todos }
const envSchema = { server: { STRIPE_KEY: v.string() } }

function createTestDeps() {
  return {
    db: { fakeDb: true } as any,
    env: { STRIPE_KEY: 'sk_test', DATABASE_URL: 'file:./x.db' } as any,
    storage: { fakeStorage: true } as any,
    email: { fakeEmail: true } as any,
    jobs: { fakeJobs: true } as any,
    realtime: { fakeRealtime: true } as any,
    auth: { fakeAuth: true } as any,
    authResolver: undefined,
  }
}

test('defineApi returns the same bases as createApiBuilder', () => {
  const o = defineApi({ schema, env: envSchema })

  expect(typeof o.public).toBe('object')
  expect(typeof o.protected).toBe('object')
  expect(typeof o.webhook).toBe('object')
})

test('defineApi infers env and schema types from the values it receives', async () => {
  const o = defineApi({ schema, env: envSchema })

  const procedure = o.public.handler(({ context }) => {
    // Compiles only when TEnv is inferred from `envSchema`.
    const key: string = context.env.STRIPE_KEY
    return { key, hasDb: !!context.db }
  })

  const client = createProcedureClient(procedure, {
    context: createApiContext(
      createTestDeps(),
      new Request('http://localhost/api/t'),
    ),
  })

  expect(await client(undefined)).toEqual({ key: 'sk_test', hasDb: true })
})

test('defineApi works without an env schema', async () => {
  const o = defineApi({ schema })

  const procedure = o.public.handler(({ context }) => {
    // Compiles only when TEnv falls back to BaseEnv.
    const url: string = context.env.DATABASE_URL
    return { url }
  })

  const client = createProcedureClient(procedure, {
    context: createApiContext(
      createTestDeps(),
      new Request('http://localhost/api/t'),
    ),
  })

  expect(await client(undefined)).toEqual({ url: 'file:./x.db' })
})
