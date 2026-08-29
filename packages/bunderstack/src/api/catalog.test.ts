import '@orpc/openapi/extensions/route'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { defineApi } from './builder'
import { describeApiOperations } from './catalog'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })
const o = defineApi({ schema: { notes } })

const router = {
  ping: o.public
    .route({ method: 'GET', path: '/api/ping', summary: '  Ping   the app  ' })
    .handler(() => ({ ok: true })),
  billing: {
    refund: o.public
      .route({ method: 'POST', path: '/api/billing/refund' })
      .handler(() => ({ ok: true })),
  },
  rpcOnly: o.public.handler(() => ({ ok: true })),
}

test('describeApiOperations walks nested namespaces in handle order', () => {
  expect(describeApiOperations(router).map((entry) => entry.handle)).toEqual([
    'billing.refund',
    'ping',
    'rpcOnly',
  ])
})

test('a declared safe method is a read and everything else is a mutation', () => {
  const byHandle = Object.fromEntries(
    describeApiOperations(router).map((entry) => [entry.handle, entry]),
  )

  expect(byHandle.ping).toEqual({
    handle: 'ping',
    operationId: 'ping',
    effect: 'read',
    method: 'GET',
    path: '/api/ping',
    summary: 'Ping the app',
  })
  expect(byHandle['billing.refund']!.effect).toBe('mutation')
})

test('a procedure without a declared route is unknown, never read', () => {
  const rpcOnly = describeApiOperations(router).find(
    (entry) => entry.handle === 'rpcOnly',
  )

  expect(rpcOnly).toEqual({
    handle: 'rpcOnly',
    operationId: 'rpcOnly',
    effect: 'unknown',
  })
})

test('an absent router describes nothing', () => {
  expect(describeApiOperations(undefined)).toEqual([])
})
