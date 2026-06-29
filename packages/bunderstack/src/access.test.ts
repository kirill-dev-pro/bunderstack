import { test, expect } from 'bun:test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

import {
  defineAccess,
  validateAndResolveAccess,
  checkAccess,
  AUTH_TABLE_NAMES,
} from './access'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  userId: text('user_id'),
})

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  image: text('image'),
})

const schema = { posts, user }

test('AUTH_TABLE_NAMES includes BetterAuth tables', () => {
  expect(AUTH_TABLE_NAMES.has('user')).toBe(true)
  expect(AUTH_TABLE_NAMES.has('session')).toBe(true)
})

test('validateAndResolveAccess applies userId convention', () => {
  const access = validateAndResolveAccess({ posts })
  expect(access.has('posts')).toBe(true)
  expect(access.get('posts')?.ownerColumn).toBe('userId')
  expect(access.get('posts')?.update).toBe('owner')
})

test('validateAndResolveAccess skips tables without owner or rules', () => {
  const orphan = sqliteTable('orphan', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label').notNull(),
  })
  const access = validateAndResolveAccess({ orphan })
  expect(access.size).toBe(0)
})

test('validateAndResolveAccess rejects unknown access keys', () => {
  expect(() =>
    validateAndResolveAccess(schema, { missing: { ownerColumn: 'userId' } }),
  ).toThrow(/does not match any table/)
})

test('validateAndResolveAccess rejects auth table access without exposeAuthTable', () => {
  expect(() =>
    validateAndResolveAccess(schema, { user: { ownerColumn: 'id' } }),
  ).toThrow(/auth table/)
  const access = validateAndResolveAccess(schema, { user: { crud: false } })
  expect(access.has('user')).toBe(false)
})

test('validateAndResolveAccess allows exposed user table', () => {
  const access = validateAndResolveAccess(schema, {
    user: {
      exposeAuthTable: true,
      ownerColumn: 'id',
      update: 'owner',
      writableColumns: ['image'],
    },
  })
  expect(access.get('user')?.enabled).toBe(true)
  expect(access.get('user')?.create).toBe('deny')
})

test('defineAccess validates and returns rules', () => {
  const rules = defineAccess(
    { posts },
    { posts: { ownerColumn: 'userId', list: 'authenticated' } },
  )
  expect(rules.posts!.list).toBe('authenticated')
})

test('checkAccess owner rule allows matching user', async () => {
  const result = await checkAccess(
    'owner',
    {
      user: { id: 'u1', email: 'a@b.com' },
      request: new Request('http://x'),
      row: { userId: 'u1' },
    },
    'userId',
  )
  expect(result.allowed).toBe(true)
})

test('checkAccess owner rule denies non-owner', async () => {
  const result = await checkAccess(
    'owner',
    {
      user: { id: 'u1', email: 'a@b.com' },
      request: new Request('http://x'),
      row: { userId: 'u2' },
    },
    'userId',
  )
  expect(result.allowed).toBe(false)
  expect(result.status).toBe(403)
})

test('checkAccess authenticated requires session', async () => {
  const denied = await checkAccess('authenticated', {
    user: null,
    request: new Request('http://x'),
  })
  expect(denied.allowed).toBe(false)
  expect(denied.status).toBe(401)
})
