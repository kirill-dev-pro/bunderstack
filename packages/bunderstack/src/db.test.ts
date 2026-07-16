import { test, expect } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createDb } from './db'

// Local fixture built with THIS package's drizzle-orm instance, so the table's
// branded types match the db client createDb produces. (Importing the table
// from examples/ pulls in a second drizzle-orm copy and breaks type identity.)
const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
})

test('createDb returns a working Drizzle instance against in-memory SQLite', async () => {
  const { db, driver } = await createDb(
    { posts },
    { url: ':memory:', dialect: 'sqlite' },
  )
  expect(driver).toBe('libsql')

  // Create the table manually (no drizzle-kit needed for the test). $client is
  // the raw libsql client — not part of the public DbFor surface — so this
  // test-only DDL escape hatch needs an explicit cast.
  await (db as unknown as { $client: { execute: (sql: string) => Promise<unknown> } }).$client.execute(
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT
    )`,
  )

  const inserted = await db.insert(posts).values({ title: 'Hello' }).returning()
  expect(inserted[0]?.title).toBe('Hello')

  const all = await db.select().from(posts)
  expect(all).toHaveLength(1)
})
