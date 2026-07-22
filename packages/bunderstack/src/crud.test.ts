import type { LibSQLDatabase } from 'drizzle-orm/libsql'

// tests/crud.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { Hono } from 'hono'

import { validateAndResolveAccess } from './access'
import { buildCrudRouter } from './crud'
import { libsql } from './database/libsql'
import { createDb } from './db'
import { withInternalTables } from './internal-tables'
import { provisionSchema } from './provision'

// Inline replica of the deleted examples/standalone posts table; the shape
// the assertions below rely on (numeric autoincrement id, authorId owner
// column, auto-defaulted createdAt).
const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
  authorId: text('authorId'),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

const testAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const userId = headers.get('x-test-user')
      if (!userId) return null
      return { user: { id: userId, email: `${userId}@test.com`, name: 'Test' } }
    },
  },
}

let app: Hono
let db: LibSQLDatabase<{ posts: typeof posts }>

beforeAll(async () => {
  ;({ db } = await createDb(
    { posts },
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  ))
  // Provision the posts table plus bunderstack's internal tables (the
  // idempotency table is no longer auto-created at runtime). Provisioning the
  // full schema avoids drizzle-kit prompting to drop unknown tables.
  const merged = withInternalTables({ posts })
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
  const access = validateAndResolveAccess(
    { posts },
    {
      posts: {
        ownerColumn: 'authorId',
        searchableColumns: ['title', 'body'],
        filterableColumns: ['authorId'],
        sortableColumns: ['createdAt', 'id'],
        defaultSort: { column: 'createdAt', order: 'desc' },
      },
    },
  )
  app = new Hono()
  app.route(
    '/api',
    buildCrudRouter({ posts }, db, {
      auth: testAuth,
      access,
      idempotency: true,
    }),
  )
})

test('POST /api/posts creates a record', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ title: 'First post' }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as {
    id: number
    title: string
    authorId: string | null
  }
  expect(body.title).toBe('First post')
  expect(body.authorId).toBe('user-1')
})

test('POST /api/posts ignores client-supplied owner column', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ title: 'Hijack', authorId: 'other-user' }),
  })
  const body = (await res.json()) as { authorId: string | null }
  expect(body.authorId).toBe('user-1')
})

test('GET /api/posts lists records', async () => {
  const res = await app.request('/api/posts')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: unknown[]; hasMore: boolean }
  expect(Array.isArray(body.items)).toBe(true)
  expect(body.items.length).toBeGreaterThan(0)
  expect(typeof body.hasMore).toBe('boolean')
})

test('GET /api/posts/:id returns one record', async () => {
  const res = await app.request('/api/posts/1')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: number }
  expect(body.id).toBe(1)
})

test('GET /api/posts/:id returns 404 for missing record', async () => {
  const res = await app.request('/api/posts/9999')
  expect(res.status).toBe(404)
})

test('PATCH /api/posts/:id forbidden without auth', async () => {
  const res = await app.request('/api/posts/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hacked' }),
  })
  expect(res.status).toBe(401)
})

test('PATCH /api/posts/:id forbidden for non-owner', async () => {
  const res = await app.request('/api/posts/1', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': 'other-user',
    },
    body: JSON.stringify({ title: 'Hacked' }),
  })
  expect(res.status).toBe(403)
})

test('PATCH /api/posts/:id updates for owner', async () => {
  const res = await app.request('/api/posts/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ title: 'Updated' }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { title: string }
  expect(body.title).toBe('Updated')
})

test('DELETE /api/posts/:id forbidden without auth', async () => {
  const res = await app.request('/api/posts/1', { method: 'DELETE' })
  expect(res.status).toBe(401)
})

test('DELETE /api/posts/:id deletes for owner', async () => {
  const create = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-2' },
    body: JSON.stringify({ title: 'To delete' }),
  })
  const { id } = (await create.json()) as { id: number }

  const res = await app.request(`/api/posts/${id}`, {
    method: 'DELETE',
    headers: { 'x-test-user': 'user-2' },
  })
  expect(res.status).toBe(204)

  const check = await app.request(`/api/posts/${id}`)
  expect(check.status).toBe(404)
})

test('GET /api/posts?q= filters searchable columns', async () => {
  await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ title: 'UniqueSearchTerm', body: 'other' }),
  })

  const hit = await app.request('/api/posts?q=UniqueSearch')
  expect(hit.status).toBe(200)
  const hitBody = (await hit.json()) as { items: { title: string }[] }
  expect(hitBody.items.some((p) => p.title === 'UniqueSearchTerm')).toBe(true)

  const miss = await app.request('/api/posts?q=NoSuchTermXYZ')
  const missBody = (await miss.json()) as { items: unknown[] }
  expect(missBody.items.length).toBe(0)
})

test('GET /api/posts defaults to stable sort order', async () => {
  const res = await app.request('/api/posts?limit=10&sort=createdAt&order=asc')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    items: { id: number; createdAt: string | Date }[]
    sort: string
    order: string
  }
  expect(body.sort).toBe('createdAt')
  expect(body.order).toBe('asc')
  for (let i = 1; i < body.items.length; i++) {
    const prev = +new Date(body.items[i - 1]!.createdAt)
    const next = +new Date(body.items[i]!.createdAt)
    expect(next).toBeGreaterThanOrEqual(prev)
  }
})

test('GET /api/posts?authorId= filters by column', async () => {
  await app.request('/api/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': 'filter-user',
    },
    body: JSON.stringify({ title: 'Filter me' }),
  })

  const res = await app.request('/api/posts?authorId=filter-user')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: { authorId: string | null }[] }
  expect(body.items.every((p) => p.authorId === 'filter-user')).toBe(true)
})

test('GET /api/posts?authorId=a,b filters by multiple values (IN)', async () => {
  await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'in-user-1' },
    body: JSON.stringify({ title: 'From user 1' }),
  })
  await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'in-user-2' },
    body: JSON.stringify({ title: 'From user 2' }),
  })
  await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'in-user-3' },
    body: JSON.stringify({ title: 'From user 3' }),
  })

  const res = await app.request('/api/posts?authorId=in-user-1,in-user-2')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: { authorId: string | null }[] }
  expect(body.items.length).toBeGreaterThanOrEqual(2)
  expect(
    body.items.every((p) => ['in-user-1', 'in-user-2'].includes(p.authorId!)),
  ).toBe(true)
  expect(body.items.some((p) => p.authorId === 'in-user-3')).toBe(false)
})

test('GET /api/posts rejects unknown filter column', async () => {
  const res = await app.request('/api/posts?unknown=1')
  expect(res.status).toBe(400)
  const body = (await res.json()) as { code: string }
  expect(body.code).toBe('VALIDATION_ERROR')
})

test('GET /api/posts rejects invalid limit', async () => {
  const res = await app.request('/api/posts?limit=-1')
  expect(res.status).toBe(400)
})

test('GET /api/posts?count=true returns total and hasMore', async () => {
  const res = await app.request('/api/posts?count=true&limit=1&offset=0')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    total: number
    hasMore: boolean
    items: unknown[]
  }
  expect(body.total).toBeGreaterThan(0)
  expect(body.hasMore).toBe(body.total > body.items.length)
})

test('GET /api/posts cursor pagination returns distinct pages', async () => {
  const page1 = await app.request('/api/posts?limit=2&sort=id&order=asc')
  const body1 = (await page1.json()) as {
    items: { id: number }[]
    nextCursor?: string
    hasMore: boolean
  }
  expect(body1.items).toHaveLength(2)
  expect(body1.nextCursor).toBeTruthy()

  const page2 = await app.request(
    `/api/posts?limit=2&sort=id&order=asc&cursor=${encodeURIComponent(body1.nextCursor!)}`,
  )
  const body2 = (await page2.json()) as { items: { id: number }[] }
  expect(body2.items[0]!.id).toBeGreaterThan(body1.items[1]!.id)
})

test('GET /api/posts rejects cursor with offset', async () => {
  const res = await app.request('/api/posts?cursor=abc&offset=1')
  expect(res.status).toBe(400)
})

test('POST /api/posts replays idempotent create', async () => {
  const key = crypto.randomUUID()
  const payload = { title: 'Idempotent post' }
  const headers = {
    'Content-Type': 'application/json',
    'x-test-user': 'user-1',
    'Idempotency-Key': key,
  }

  const first = await app.request('/api/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const second = await app.request('/api/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  expect(first.status).toBe(201)
  expect(second.status).toBe(201)
  expect(second.headers.get('Idempotency-Replayed')).toBe('true')
  const a = await first.json()
  const b = await second.json()
  expect(a).toEqual(b)
})

test('POST /api/posts conflicts on idempotency key with different body', async () => {
  const key = crypto.randomUUID()
  const headers = {
    'Content-Type': 'application/json',
    'x-test-user': 'user-1',
    'Idempotency-Key': key,
  }

  await app.request('/api/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'First body' }),
  })
  const conflict = await app.request('/api/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Different body' }),
  })
  expect(conflict.status).toBe(409)
  const body = (await conflict.json()) as { code: string }
  expect(body.code).toBe('IDEMPOTENCY_CONFLICT')
})
