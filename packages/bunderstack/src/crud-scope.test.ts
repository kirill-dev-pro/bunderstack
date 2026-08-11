import { createClient } from '@libsql/client'
import { describe, expect, it } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from './access'
import { createCrudOperations, CrudOperationError } from './crud-operations'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }

async function makeOperations(orgId: string | null) {
  const client = createClient({ url: ':memory:' })
  await client.execute(
    'CREATE TABLE boards (id text primary key, organization_id text not null, title text not null)',
  )
  await client.execute(
    "INSERT INTO boards VALUES ('b1','org_1','One'),('b2','org_2','Two')",
  )
  const db = drizzle(client, { schema })
  const access = validateAndResolveAccess(schema, {
    boards: {
      list: 'authenticated',
      get: 'authenticated',
      create: 'authenticated',
      update: 'authenticated',
      delete: 'authenticated',
      scope: {
        read: (context) => ({
          organizationId: context.session?.activeOrganizationId ?? '',
        }),
        write: (context) => ({
          organizationId: context.session?.activeOrganizationId ?? '',
        }),
      },
    },
  })
  return {
    operations: createCrudOperations({ schema, db: db as never, access }),
    context: {
      request: new Request('http://x/api/boards'),
      user: { id: 'u_1', email: 'a@b.c', name: 'A' },
      session: { activeOrganizationId: orgId },
    },
  }
}

describe('crud scope operations', () => {
  it('list only returns rows in the active org', async () => {
    const { operations, context } = await makeOperations('org_1')
    const result = await operations.list('boards', undefined, context)
    expect(result.items.map((board) => board.id)).toEqual(['b1'])
  })

  it('get of an out-of-scope row is NOT_FOUND', async () => {
    const { operations, context } = await makeOperations('org_1')
    const error = await operations
      .get('boards', 'b2', context)
      .catch((value) => value)
    expect(error).toBeInstanceOf(CrudOperationError)
    expect(error.code).toBe('NOT_FOUND')
  })

  it('create stamps the active org, ignoring a spoofed organizationId', async () => {
    const { operations, context } = await makeOperations('org_1')
    const result = await operations.create(
      'boards',
      { id: 'b3', title: 'New', organizationId: 'org_2' },
      undefined,
      undefined,
      context,
    )
    expect(result.record.organizationId).toBe('org_1')
  })

  it('update of an out-of-scope row is NOT_FOUND', async () => {
    const { operations, context } = await makeOperations('org_1')
    const error = await operations
      .update('boards', 'b2', { title: 'Hacked' }, context)
      .catch((value) => value)
    expect(error).toBeInstanceOf(CrudOperationError)
    expect(error.code).toBe('NOT_FOUND')
  })
})
