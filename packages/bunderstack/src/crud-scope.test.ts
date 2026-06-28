// packages/bunderstack/src/crud-scope.test.ts
import { describe, it, expect, beforeAll } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { buildCrudRouter } from './crud.ts'
import { validateAndResolveAccess } from './access.ts'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
})
const schema = { boards }

function authFor(orgId: string | null) {
  return {
    api: {
      getSession: async () => ({
        user: { id: 'u_1', email: 'a@b.c', name: 'A' },
        session: { activeOrganizationId: orgId },
      }),
    },
  }
}

async function makeRouter(orgId: string | null) {
  const client = createClient({ url: ':memory:' })
  await client.execute('CREATE TABLE boards (id text primary key, organization_id text not null, title text not null)')
  await client.execute("INSERT INTO boards VALUES ('b1','org_1','One'),('b2','org_2','Two')")
  const db = drizzle(client, { schema })
  const access = validateAndResolveAccess(schema, {
    boards: {
      list: 'authenticated', get: 'authenticated', create: 'authenticated',
      update: 'authenticated', delete: 'authenticated',
      scope: (ctx) => ({ organizationId: ctx.session?.activeOrganizationId ?? '' }),
    },
  })
  return buildCrudRouter(schema, db as never, { auth: authFor(orgId) as never, access })
}

describe('crud scope', () => {
  it('list only returns rows in the active org', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(new Request('http://x/boards'))
    const body = (await res.json()) as { items: { id: string }[] }
    expect(body.items.map((b) => b.id)).toEqual(['b1'])
  })
  it('get of an out-of-scope row is 404', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(new Request('http://x/boards/b2'))
    expect(res.status).toBe(404)
  })
  it('create stamps the active org, ignoring a spoofed organizationId', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(new Request('http://x/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'b3', title: 'New', organizationId: 'org_2' }),
    }))
    const body = (await res.json()) as { organizationId: string }
    expect(body.organizationId).toBe('org_1')
  })
  it('update of an out-of-scope row is 404', async () => {
    const router = await makeRouter('org_1')
    const res = await router.fetch(new Request('http://x/boards/b2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hacked' }),
    }))
    expect(res.status).toBe(404)
  })
})
