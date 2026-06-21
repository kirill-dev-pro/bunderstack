import { test, expect } from 'bun:test'
import { createDb } from '../src/db'
import { posts } from '../examples/standalone/schema'

test('createDb returns a working Drizzle instance against in-memory SQLite', async () => {
  const db = createDb({ posts }, { url: ':memory:' })

  // Create the table manually (no drizzle-kit needed for the test)
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      author_id TEXT,
      created_at INTEGER
    )`
  )

  const inserted = await db.insert(posts).values({ title: 'Hello' }).returning()
  expect(inserted[0]?.title).toBe('Hello')

  const all = await db.select().from(posts)
  expect(all).toHaveLength(1)
})
