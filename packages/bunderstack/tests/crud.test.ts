// tests/crud.test.ts
import { test, expect, beforeAll } from 'bun:test'
import { createDb } from '../src/db'
import { buildCrudRouter } from '../src/crud'
import { posts } from '../../../examples/standalone/schema'
import { Hono } from 'hono'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

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
  app = new Hono()
  app.route('/api', buildCrudRouter({ posts }, db))
})

test('POST /api/posts creates a record', async () => {
  const res = await app.request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'First post' }),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { id: number; title: string }
  expect(body.title).toBe('First post')
  expect(typeof body.id).toBe('number')
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

test('PATCH /api/posts/:id updates a record', async () => {
  const res = await app.request('/api/posts/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Updated' }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { title: string }
  expect(body.title).toBe('Updated')
})

test('DELETE /api/posts/:id deletes a record', async () => {
  const res = await app.request('/api/posts/1', { method: 'DELETE' })
  expect(res.status).toBe(204)

  const check = await app.request('/api/posts/1')
  expect(check.status).toBe(404)
})
