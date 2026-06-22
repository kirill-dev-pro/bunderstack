// tests/crud.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { createDb } from '../src/db'
import { buildCrudRouter } from '../src/crud'
import { validateAndResolveAccess } from '../src/access'
import { posts } from '../../../examples/standalone/schema'
import { Hono } from 'hono'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

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
  db = createDb({ posts }, { url: ':memory:' })
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      author_id TEXT,
      created_at INTEGER
    )`
  )
  const access = validateAndResolveAccess(
    { posts },
    { posts: { ownerColumn: 'authorId', searchableColumns: ['title', 'body'] } },
  )
  app = new Hono()
  app.route('/api', buildCrudRouter({ posts }, db, { auth: testAuth, access }))
})

test('POST /api/posts creates a record', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ title: 'First post' }),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { id: number; title: string; authorId: string | null }
  expect(body.title).toBe('First post')
  expect(body.authorId).toBe('user-1')
})

test('POST /api/posts ignores client-supplied owner column', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ title: 'Hijack', authorId: 'other-user' }),
  })
  const body = await res.json() as { authorId: string | null }
  expect(body.authorId).toBe('user-1')
})

test('GET /api/posts lists records', async () => {
  const res = await app.request('/api/posts')
  expect(res.status).toBe(200)
  const body = await res.json() as { items: unknown[] }
  expect(Array.isArray(body.items)).toBe(true)
  expect(body.items.length).toBeGreaterThan(0)
})

test('GET /api/posts/:id returns one record', async () => {
  const res = await app.request('/api/posts/1')
  expect(res.status).toBe(200)
  const body = await res.json() as { id: number }
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
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'other-user' },
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
  const body = await res.json() as { title: string }
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
  const { id } = await create.json() as { id: number }

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
  const hitBody = await hit.json() as { items: { title: string }[] }
  expect(hitBody.items.some((p) => p.title === 'UniqueSearchTerm')).toBe(true)

  const miss = await app.request('/api/posts?q=NoSuchTermXYZ')
  const missBody = await miss.json() as { items: unknown[] }
  expect(missBody.items.length).toBe(0)
})
