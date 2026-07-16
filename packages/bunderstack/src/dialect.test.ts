import { test, expect } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { detectDialect } from './dialect'

const sqlitePosts = sqliteTable('posts', { id: text('id').primaryKey() })
const pgPosts = pgTable('posts', { id: pgText('id').primaryKey() })

test('sqlite-only schema detects sqlite', () => {
  expect(detectDialect({ posts: sqlitePosts })).toBe('sqlite')
})

test('pg-only schema detects pg', () => {
  expect(detectDialect({ posts: pgPosts })).toBe('pg')
})

test('empty schema defaults to sqlite', () => {
  expect(detectDialect({})).toBe('sqlite')
})

test('non-table values (relations, helpers) are ignored', () => {
  expect(detectDialect({ posts: pgPosts, helper: () => 1, n: 42 })).toBe('pg')
})

test('mixed dialects throw with both table keys named', () => {
  expect(() => detectDialect({ a: pgPosts, b: sqlitePosts })).toThrow(
    /mixes dialects.*"a".*"b"/s,
  )
})
