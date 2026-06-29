import { test, expect, beforeAll } from 'bun:test'
import { getTableName, isTable } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from './access'
import { createDb } from './db'
import {
  bunderstackFiles,
  bunderstackIdempotency,
  INTERNAL_TABLES,
  INTERNAL_TABLE_NAMES,
  withInternalTables,
} from './internal-tables'
import { provisionSchema } from './provision'

// --- table name resolution ---

test('bunderstackFiles has table name bunderstack_file_meta', () => {
  expect(getTableName(bunderstackFiles)).toBe('bunderstack_file_meta')
})

test('bunderstackIdempotency has table name _bunderstack_idempotency', () => {
  expect(getTableName(bunderstackIdempotency)).toBe('_bunderstack_idempotency')
})

// --- INTERNAL_TABLE_NAMES ---

test('INTERNAL_TABLE_NAMES contains exactly the two internal table names', () => {
  expect(INTERNAL_TABLE_NAMES.has('bunderstack_file_meta')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.has('_bunderstack_idempotency')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.size).toBe(2)
})

// --- INTERNAL_TABLES ---

test('INTERNAL_TABLES contains both tables', () => {
  expect(isTable(INTERNAL_TABLES.bunderstackFiles)).toBe(true)
  expect(isTable(INTERNAL_TABLES.bunderstackIdempotency)).toBe(true)
})

// --- withInternalTables ---

test('withInternalTables({}) returns object with both internal tables', () => {
  const merged = withInternalTables({})
  expect(isTable(merged.bunderstackFiles)).toBe(true)
  expect(isTable(merged.bunderstackIdempotency)).toBe(true)
})

test('withInternalTables preserves user tables', () => {
  const userTable = sqliteTable('posts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
  })
  const merged = withInternalTables({ userTable })
  expect(isTable(merged.userTable)).toBe(true)
  expect(isTable(merged.bunderstackFiles)).toBe(true)
  expect(isTable(merged.bunderstackIdempotency)).toBe(true)
})

test('withInternalTables dedupes re-exported internal tables', () => {
  const merged = withInternalTables({
    bunderstackFiles,
    bunderstackIdempotency,
  })
  expect(isTable(merged.bunderstackFiles)).toBe(true)
  expect(isTable(merged.bunderstackIdempotency)).toBe(true)
  expect(merged.bunderstackFiles).toBe(bunderstackFiles)
})

test('withInternalTables throws on foreign reserved name bunderstack_file_meta', () => {
  const clash = sqliteTable('bunderstack_file_meta', {
    id: text('id').primaryKey(),
  })
  expect(() => withInternalTables({ clash })).toThrow(
    '[bunderstack] table name "bunderstack_file_meta" is reserved by bunderstack',
  )
})

test('withInternalTables throws on foreign reserved name _bunderstack_idempotency', () => {
  const clash = sqliteTable('_bunderstack_idempotency', {
    key: text('key').notNull(),
    table_name: text('table_name').notNull(),
  })
  expect(() => withInternalTables({ clash })).toThrow(
    '[bunderstack] table name "_bunderstack_idempotency" is reserved by bunderstack',
  )
})

// --- access exclusion ---

test('validateAndResolveAccess excludes internal tables from CRUD', () => {
  const merged = withInternalTables({})
  const resolved = validateAndResolveAccess(merged)
  expect(resolved.has('bunderstackFiles')).toBe(false)
  expect(resolved.has('bunderstackIdempotency')).toBe(false)
})

// --- provision round-trip ---

let db: ReturnType<typeof createDb<typeof INTERNAL_TABLES>>

beforeAll(async () => {
  db = createDb(INTERNAL_TABLES, { url: ':memory:' })
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
})

test('provision round-trip: insert+select bunderstackFiles', async () => {
  const now = Date.now()
  await db.insert(bunderstackFiles).values({
    fileId: 'test-file-1',
    bucket: 'uploads',
    ownerId: 'user-abc',
    status: 'pending',
    createdAt: now,
  })

  const allRows = await db.select().from(bunderstackFiles)
  expect(allRows.length).toBeGreaterThan(0)
  const inserted = allRows.find((r) => r.fileId === 'test-file-1')
  expect(inserted).toBeDefined()
  expect(inserted!.bucket).toBe('uploads')
  expect(inserted!.ownerId).toBe('user-abc')
  expect(inserted!.status).toBe('pending')
  expect(inserted!.createdAt).toBe(now)
})

test('provision round-trip: insert+select bunderstackIdempotency', async () => {
  const expiresAt = Date.now() + 60_000
  await db.insert(bunderstackIdempotency).values({
    key: 'key-1',
    tableName: 'posts',
    bodyHash: 'abc123',
    status: 201,
    response: '{"id":1}',
    expiresAt,
  })

  const allRows = await db.select().from(bunderstackIdempotency)
  expect(allRows.length).toBeGreaterThan(0)
  const inserted = allRows.find(
    (r) => r.key === 'key-1' && r.tableName === 'posts',
  )
  expect(inserted).toBeDefined()
  expect(inserted!.bodyHash).toBe('abc123')
  expect(inserted!.status).toBe(201)
  expect(inserted!.response).toBe('{"id":1}')
  expect(inserted!.expiresAt).toBe(expiresAt)
})
