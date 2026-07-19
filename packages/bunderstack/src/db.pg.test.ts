import { test, expect } from 'bun:test'
import { pgTable, serial, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bunSql } from './database/bun-sql'
import { libsql } from './database/libsql'
import { pglite } from './database/pglite'
import { createDb } from './db'

const pgPosts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: pgText('title').notNull(),
})
const sqlitePosts = sqliteTable('posts', { id: text('id').primaryKey() })

test('pg schema + memory:// creates a working PGlite db', async () => {
  const { db, driver } = await createDb(
    { posts: pgPosts },
    { url: 'memory://', dialect: 'pg', adapter: pglite() },
  )
  expect(driver).toBe('pglite')
  await db.execute(
    `CREATE TABLE posts (id serial PRIMARY KEY, title text NOT NULL)` as never,
  )
  const rows = await db.insert(pgPosts).values({ title: 'hi' }).returning()
  expect(rows[0]?.title).toBe('hi')
})

test("pg schema + ':memory:' is normalized to in-memory PGlite", async () => {
  const { driver } = await createDb(
    { posts: pgPosts },
    { url: ':memory:', dialect: 'pg', adapter: pglite() },
  )
  expect(driver).toBe('pglite')
})

test('pg schema + file:<nested/dir> creates the PGlite data directory and is queryable', async () => {
  // Nested (multi-level) path: PGlite's own NodeFS does a non-recursive
  // mkdirSync, so this only works because createDb pre-creates the full
  // directory tree first. Drive an actual query rather than just checking
  // the directory exists — PGlite's WASM init only fully settles (and
  // surfaces any init failure) once something awaits a real query.
  const parent = await mkdtemp(join(tmpdir(), 'bunderstack-pglite-'))
  const dataDir = join(parent, 'nested', 'pgdata')
  try {
    const { db, driver } = await createDb(
      { posts: pgPosts },
      { url: `file:${dataDir}`, dialect: 'pg', adapter: pglite() },
    )
    expect(driver).toBe('pglite')
    await db.execute(
      `CREATE TABLE posts (id serial PRIMARY KEY, title text NOT NULL)` as never,
    )
    const rows = await db.insert(pgPosts).values({ title: 'hi' }).returning()
    expect(rows[0]?.title).toBe('hi')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('pg schema + postgres:// picks bun-sql under Bun without connecting', async () => {
  const { driver } = await createDb(
    { posts: pgPosts },
    {
      url: 'postgres://user:pw@localhost:5/db',
      dialect: 'pg',
      adapter: bunSql(),
    },
  )
  expect(driver).toBe('bun-sql')
})

test('sqlite schema + postgres:// URL throws a dialect-contradiction error', async () => {
  await expect(
    createDb(
      { posts: sqlitePosts },
      { url: 'postgres://x/y', dialect: 'sqlite', adapter: libsql() },
    ),
  ).rejects.toThrow(/Postgres URL.*sqliteTable/s)
})

test('pg schema + libsql URL throws a dialect-contradiction error', async () => {
  await expect(
    createDb(
      { posts: pgPosts },
      { url: 'libsql://foo.turso.io', dialect: 'pg', adapter: pglite() },
    ),
  ).rejects.toThrow(/libsql.*pgTable/s)
})
