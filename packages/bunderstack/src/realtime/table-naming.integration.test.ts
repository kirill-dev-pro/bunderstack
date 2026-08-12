import { test, expect, beforeAll, afterAll } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'

/**
 * The schema key and the SQL table name differ here on purpose: every example
 * in this repo names them the same, which is why the two used to drift apart
 * without any test noticing.
 */
const creditBalances = sqliteTable('credit_balances', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  amount: integer('amount').notNull(),
})

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
})

const schema = { user, session, account, verification, creditBalances }

const createApp = () =>
  createBunderstack({
    schema,
    database: { url: ':memory:', adapter: libsql() },
    auth: {},
    realtime: true,
    access: {
      creditBalances: { crud: true, list: 'public', get: 'public' },
    },
  })

let app: Awaited<ReturnType<typeof createApp>>

beforeAll(async () => {
  app = await createApp()
  await provision(app, { force: true })
})

afterAll(async () => {
  await app.close()
})

/** Opens the SSE stream and resolves with the first `change` event's data. */
async function firstChange(tables: string): Promise<Record<string, unknown>> {
  const res = await app.handler(
    new Request(`http://localhost/api/realtime?tables=${tables}`, {
      headers: { Accept: 'text/event-stream' },
    }),
  )
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''

  const read = async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error('stream ended before a change arrived')
      buffered += decoder.decode(value, { stream: true })
      for (const chunk of buffered.split('\n\n')) {
        const data = chunk
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice('data:'.length)
          .trim()
        if (!data) continue
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed['json']) {
          const payload = parsed['json'] as Record<string, unknown>
          if (payload['type'] === 'heartbeat') continue
          return payload
        }
        if (parsed['type'] === 'heartbeat') continue
        return parsed
      }
    }
  }

  const pending = read()
  // Give the subscription a tick to attach before the write it should see.
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.realtime.publish(creditBalances, 'create', {
    id: 'cb1',
    userId: 'u1',
    amount: 10,
  })
  const event = await pending
  await reader.cancel()
  return event
}

test('a realtime event names the table by its schema key', async () => {
  const event = await firstChange('creditBalances')
  expect(event['table']).toBe('creditBalances')
  expect(event['action']).toBe('create')
})

test('subscribing by the schema key delivers events', async () => {
  const event = await firstChange('creditBalances')
  expect(event['record']).toMatchObject({ id: 'cb1', amount: 10 })
})
