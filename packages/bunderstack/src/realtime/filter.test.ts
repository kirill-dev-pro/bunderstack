import { getEventMeta, withEventMeta } from '@orpc/server'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { RealtimeChange } from './publisher'

import { validateAndResolveAccess } from '../access'
import { filterRealtimeChanges } from './filter'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  ownerId: text('owner_id').notNull(),
})
const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
})

async function* changes(...items: RealtimeChange[]) {
  yield* items
}

const event = (
  table: string,
  record: Record<string, unknown>,
): RealtimeChange => ({ table, action: 'update', record })

test('filters requested tables and avoids session work for public access', async () => {
  const access = validateAndResolveAccess(
    { boards, secrets },
    {
      boards: { crud: true, list: 'public', get: 'public' },
      secrets: {
        crud: true,
        list: 'authenticated',
        get: 'authenticated',
      },
    },
  )
  let sessionCalls = 0
  const filtered = filterRealtimeChanges(
    changes(event('boards', { id: 'b1' }), event('secrets', { id: 's1' })),
    {
      subscriptions: ['boards'],
      access,
      request: new Request('http://test/api/realtime'),
      getSession: async () => {
        sessionCalls++
        return { user: null, activeOrganizationId: null }
      },
    },
  )

  const output: RealtimeChange[] = []
  for await (const change of filtered) output.push(change)
  expect(output.map((change) => change.table)).toEqual(['boards'])
  expect(sessionCalls).toBe(0)
})

test('applies authenticated owner, organization scope, and async predicates', async () => {
  const access = validateAndResolveAccess(
    { boards },
    {
      boards: {
        crud: true,
        list: 'authenticated',
        get: async (ctx) =>
          ctx.user?.id === ctx.row?.ownerId && ctx.user?.role === 'member',
        scope: {
          read: (ctx) => ({
            organizationId: ctx.session?.activeOrganizationId ?? '',
          }),
        },
      },
    },
  )
  let sessionCalls = 0
  const filtered = filterRealtimeChanges(
    changes(
      event('boards', {
        id: 'visible',
        ownerId: 'u1',
        organizationId: 'org1',
      }),
      event('boards', {
        id: 'wrong-owner',
        ownerId: 'u2',
        organizationId: 'org1',
      }),
      event('boards', {
        id: 'wrong-org',
        ownerId: 'u1',
        organizationId: 'org2',
      }),
    ),
    {
      subscriptions: ['boards'],
      access,
      request: new Request('http://test/api/realtime'),
      getSession: async () => {
        sessionCalls++
        return {
          user: { id: 'u1', email: 'u1@test.dev', role: 'member' },
          activeOrganizationId: 'org1',
        }
      },
    },
  )

  const ids: unknown[] = []
  for await (const change of filtered) ids.push(change.record.id)
  expect(ids).toEqual(['visible'])
  expect(sessionCalls).toBe(1)
})

test('supports record subscriptions and preserves Publisher event metadata', async () => {
  const access = validateAndResolveAccess(
    { boards },
    { boards: { crud: true, list: 'public', get: 'public' } },
  )
  const source = withEventMeta(event('boards', { id: 'b1' }), {
    id: 'evt-42',
  })
  const filtered = filterRealtimeChanges(changes(source), {
    subscriptions: ['boards/b1'],
    access,
    request: new Request('http://test/api/realtime'),
    getSession: async () => ({ user: null, activeOrganizationId: null }),
  })

  const output = await filtered.next()
  expect(output.value?.record.id).toBe('b1')
  expect(getEventMeta(output.value)?.id).toBe('evt-42')
})

test('returning the filtered iterator closes the Publisher subscription', async () => {
  let closed = false
  async function* source() {
    try {
      yield event('boards', { id: 'b1' })
      await new Promise(() => {})
    } finally {
      closed = true
    }
  }
  const access = validateAndResolveAccess(
    { boards },
    { boards: { crud: true, list: 'public', get: 'public' } },
  )
  const filtered = filterRealtimeChanges(source(), {
    subscriptions: ['boards'],
    access,
    request: new Request('http://test/api/realtime'),
    getSession: async () => ({ user: null, activeOrganizationId: null }),
  })

  await filtered.next()
  await filtered.return(undefined)
  expect(closed).toBe(true)
})
