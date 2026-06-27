// packages/bunderstack/src/crud-broadcast.test.ts
import { describe, it, expect } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { buildCrudRouter } from './crud.ts'
import { createRealtimeBroker } from './realtime.ts'
import { validateAndResolveAccess } from './access.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }
const auth = { api: { getSession: async () => ({ user: { id: 'u_1', email: 'a@b.c' }, session: { activeOrganizationId: 'org_1' } }) } }

it('publishes a create event after insert', async () => {
  const client = createClient({ url: ':memory:' })
  await client.execute('CREATE TABLE boards (id text primary key, organization_id text not null, title text not null)')
  const db = drizzle(client, { schema })
  const access = validateAndResolveAccess(schema, {
    boards: { create: 'authenticated', list: 'authenticated', get: 'authenticated', scope: (c) => ({ organizationId: c.session?.activeOrganizationId ?? '' }) },
  })
  const broker = createRealtimeBroker({ access })
  const received: unknown[] = []
  const s = broker.register((d) => received.push(JSON.parse(d)))
  broker.setContext(s.id, { user: { id: 'u_1', email: 'a@b.c' }, activeOrganizationId: 'org_1', subscriptions: new Set(['boards']) })

  const router = buildCrudRouter(schema, db as never, { auth: auth as never, access, broker })
  await router.fetch(new Request('http://x/boards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'b1', title: 'X' }),
  }))

  expect(received).toContainEqual({ eventId: 1, action: 'create', table: 'boards', record: { id: 'b1', organizationId: 'org_1', title: 'X' } })
})
