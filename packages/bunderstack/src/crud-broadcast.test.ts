import { createClient } from '@libsql/client'
// packages/bunderstack/src/crud-broadcast.test.ts
import { it, expect } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from './access'
import { createCrudOperations } from './crud-operations'
import { createRealtimeFacade } from './realtime/facade'
import { createMemoryRealtimePublisher } from './realtime/publisher'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }
it('publishes a create event after insert', async () => {
  const client = createClient({ url: ':memory:' })
  await client.execute(
    'CREATE TABLE boards (id text primary key, organization_id text not null, title text not null)',
  )
  const db = drizzle(client, { schema })
  const access = validateAndResolveAccess(schema, {
    boards: {
      create: 'authenticated',
      list: 'authenticated',
      get: 'authenticated',
      scope: {
        read: (c) => ({
          organizationId: c.session?.activeOrganizationId ?? '',
        }),
        write: (c) => ({
          organizationId: c.session?.activeOrganizationId ?? '',
        }),
      },
    },
  })
  const publisher = createMemoryRealtimePublisher()
  const received = publisher.subscribe('change')

  const operations = createCrudOperations({
    schema,
    db: db as never,
    access,
    realtime: createRealtimeFacade<typeof schema>(publisher),
  })
  await operations.create(
    'boards',
    { id: 'b1', title: 'X' },
    undefined,
    undefined,
    {
      request: new Request('http://x/api/boards', {
        headers: { 'x-bunderstack-operation-id': 'op-create-board' },
      }),
      user: { id: 'u_1', email: 'a@b.c' },
      session: { activeOrganizationId: 'org_1' },
    },
  )

  expect((await received.next()).value).toEqual({
    action: 'create',
    table: 'boards',
    operationId: 'op-create-board',
    record: { id: 'b1', organizationId: 'org_1', title: 'X' },
  })
})
