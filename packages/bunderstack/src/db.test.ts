import { test, expect } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { DatabaseAdapter } from './database/adapter'

import { createDb } from './db'

const fakeAdapter = (
  dialect: 'sqlite' | 'pg',
  connectCalls: unknown[] = [],
): DatabaseAdapter => ({
  dialect,
  driver: 'libsql',
  connect: async (_, conn) => {
    connectCalls.push(conn)
    return {} as never
  },
  migrate: async () => {},
})

// Local fixture built with THIS package's drizzle-orm instance, so the table's
// branded types match the db client createDb produces. (Importing the table
// from examples/ pulls in a second drizzle-orm copy and breaks type identity.)
const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
})

test('createDb returns a working Drizzle instance against in-memory SQLite', async () => {
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    connect: async (schema, connection) => {
      const { drizzle } = await import('drizzle-orm/libsql')
      return drizzle({ connection, schema }) as never
    },
    migrate: async () => {},
  }
  const { db, driver } = await createDb(
    { posts },
    { url: ':memory:', dialect: 'sqlite', adapter },
  )
  expect(driver).toBe('libsql')

  // Create the table manually (no drizzle-kit needed for the test). $client is
  // the raw libsql client — not part of the public DbFor surface — so this
  // test-only DDL escape hatch needs an explicit cast.
  await (
    db as unknown as { $client: { execute: (sql: string) => Promise<unknown> } }
  ).$client.execute(
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

const pgSchema = { posts: pgTable('posts', { id: pgText('id').primaryKey() }) }

test('rejects sqlite schema with pg adapter', () => {
  expect(
    createDb(
      { posts },
      { url: 'file:test.db', dialect: 'sqlite', adapter: fakeAdapter('pg') },
    ),
  ).rejects.toThrow(
    '[bunderstack] database adapter dialect pg does not match sqlite schema',
  )
})

test('rejects pg schema with sqlite adapter', () => {
  expect(
    createDb(pgSchema, {
      url: 'postgres://test',
      dialect: 'pg',
      adapter: fakeAdapter('sqlite'),
    }),
  ).rejects.toThrow(
    '[bunderstack] database adapter dialect sqlite does not match pg schema',
  )
})

test('connect receives resolved URL and auth token exactly once', async () => {
  const calls: unknown[] = []
  await createDb(
    { posts },
    {
      url: 'file:test.db',
      authToken: 'secret',
      dialect: 'sqlite',
      adapter: fakeAdapter('sqlite', calls),
    },
  )
  expect(calls).toEqual([{ url: 'file:test.db', authToken: 'secret' }])
  expect(calls).toHaveLength(1)
})
