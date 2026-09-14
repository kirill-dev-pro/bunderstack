import { test, expect, beforeAll } from 'bun:test'
import { getTableName, is, isTable } from 'drizzle-orm'
import {
  getTableConfig as getPgTableConfig,
  PgTable,
  pgTable,
  text as pgText,
} from 'drizzle-orm/pg-core'
import {
  getTableConfig as getSqliteTableConfig,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

import { validateAndResolveAccess } from './access'
import { libsql } from './database/libsql'
import { createDb } from './db'
import {
  bunderstackMessageEvents,
  bunderstackMessages,
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
  INTERNAL_TABLES,
  INTERNAL_TABLE_NAMES,
  jobsTableFor,
  withInternalTables,
} from './internal-tables'
import {
  bunderstackMessageEventsPg,
  bunderstackMessagesPg,
  bunderstackFilesPg,
  bunderstackIdempotencyPg,
  bunderstackJobsPg,
} from './internal-tables-pg'
import { provisionSchema } from './provision-schema'

// --- table name resolution ---

test('bunderstackFiles has table name bunderstack_file_meta', () => {
  expect(getTableName(bunderstackFiles)).toBe('bunderstack_file_meta')
})

test('bunderstackIdempotency has table name _bunderstack_idempotency', () => {
  expect(getTableName(bunderstackIdempotency)).toBe('_bunderstack_idempotency')
})

// --- INTERNAL_TABLE_NAMES ---

test('INTERNAL_TABLE_NAMES contains every internal table name', () => {
  expect(INTERNAL_TABLE_NAMES.has('bunderstack_file_meta')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.has('_bunderstack_idempotency')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.has('_bunderstack_jobs')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.has('_bunderstack_messages')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.has('_bunderstack_message_events')).toBe(true)
  expect(INTERNAL_TABLE_NAMES.size).toBe(5)
})

// --- INTERNAL_TABLES ---

test('INTERNAL_TABLES contains both tables', () => {
  expect(isTable(INTERNAL_TABLES.bunderstackFiles)).toBe(true)
  expect(isTable(INTERNAL_TABLES.bunderstackIdempotency)).toBe(true)
  expect(isTable(INTERNAL_TABLES.bunderstackMessages)).toBe(true)
  expect(isTable(INTERNAL_TABLES.bunderstackMessageEvents)).toBe(true)
})

// --- withInternalTables ---

test('withInternalTables({}) returns object with both internal tables', () => {
  const merged = withInternalTables({})
  expect(isTable(merged.bunderstackFiles)).toBe(true)
  expect(isTable(merged.bunderstackIdempotency)).toBe(true)
  expect(isTable(merged.bunderstackMessages)).toBe(true)
  expect(isTable(merged.bunderstackMessageEvents)).toBe(true)
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

// --- pg twins ---

const pgPosts = pgTable('pg_posts', { id: pgText('id').primaryKey() })

test('withInternalTables merges pg twins into a pg schema', () => {
  const merged = withInternalTables({ pgPosts })
  expect(is(merged.bunderstackFiles, PgTable)).toBe(true)
  expect(is(merged.bunderstackIdempotency, PgTable)).toBe(true)
  expect(is(merged.bunderstackMessages, PgTable)).toBe(true)
  expect(is(merged.bunderstackMessageEvents, PgTable)).toBe(true)
})

test('withInternalTables accepts the pg twins re-exported into the schema', () => {
  const merged = withInternalTables({
    pgPosts,
    bunderstackFiles: bunderstackFilesPg,
    bunderstackIdempotency: bunderstackIdempotencyPg,
  })
  expect(merged.bunderstackFiles).toBe(bunderstackFilesPg as never)
})

test('withInternalTables still rejects foreign pg tables using reserved names', () => {
  const impostor = pgTable('bunderstack_file_meta', {
    id: pgText('id').primaryKey(),
  })
  expect(() => withInternalTables({ impostor })).toThrow(/reserved/)
})

// --- access exclusion ---

test('validateAndResolveAccess excludes internal tables from CRUD', () => {
  const merged = withInternalTables({})
  const resolved = validateAndResolveAccess(merged)
  expect(resolved.has('bunderstackFiles')).toBe(false)
  expect(resolved.has('bunderstackIdempotency')).toBe(false)
  expect(resolved.has('bunderstackMessages')).toBe(false)
  expect(resolved.has('bunderstackMessageEvents')).toBe(false)
})

// --- provision round-trip ---

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']

beforeAll(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
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

// --- jobs table ---

test('jobs table is registered as an internal table in both dialects', () => {
  expect(getTableName(bunderstackJobs)).toBe('_bunderstack_jobs')
  expect(getTableName(bunderstackJobsPg)).toBe('_bunderstack_jobs')
  expect(isTable(bunderstackJobs)).toBe(true)
  expect(is(bunderstackJobsPg, PgTable)).toBe(true)
  expect(INTERNAL_TABLE_NAMES.has('_bunderstack_jobs')).toBe(true)
})

test('jobs table indexes newest cron rows by type and runAt in both dialects', () => {
  const sqliteNames = getSqliteTableConfig(bunderstackJobs).indexes.map(
    (entry) => entry.config.name,
  )
  const pgNames = getPgTableConfig(bunderstackJobsPg).indexes.map(
    (entry) => entry.config.name,
  )

  expect(sqliteNames).toContain('bjq_type_run_at')
  expect(pgNames).toContain('bjq_type_run_at')
})

test('withInternalTables merges the jobs table', () => {
  const merged = withInternalTables({})
  expect(isTable(merged.bunderstackJobs)).toBe(true)
})

test('jobsTableFor picks the sqlite twin for a non-pg db', () => {
  expect(jobsTableFor({})).toBe(bunderstackJobs)
})

test('provision round-trip: insert+select bunderstackJobs', async () => {
  const now = Date.now()
  await db.insert(bunderstackJobs).values({
    id: 'job_test1',
    type: 'greet',
    payloadJson: '{}',
    status: 'pending',
    attempts: 0,
    runAt: now,
    createdAt: now,
  })

  const allRows = await db.select().from(bunderstackJobs)
  const inserted = allRows.find((r) => r.id === 'job_test1')
  expect(inserted).toBeDefined()
  expect(inserted!.type).toBe('greet')
  expect(inserted!.status).toBe('pending')
  expect(inserted!.attempts).toBe(0)
})

test('message journal tables are registered in both dialects', () => {
  expect(getTableName(bunderstackMessages)).toBe('_bunderstack_messages')
  expect(getTableName(bunderstackMessageEvents)).toBe(
    '_bunderstack_message_events',
  )
  expect(getTableName(bunderstackMessagesPg)).toBe('_bunderstack_messages')
  expect(getTableName(bunderstackMessageEventsPg)).toBe(
    '_bunderstack_message_events',
  )
  expect(is(bunderstackMessagesPg, PgTable)).toBe(true)
  expect(is(bunderstackMessageEventsPg, PgTable)).toBe(true)
})

test('provision round-trip: insert message and provider event', async () => {
  const now = Date.now()
  await db.insert(bunderstackMessages).values({
    id: 'message_test1',
    channel: 'email',
    kind: 'email',
    provider: 'resend',
    credentialSource: 'capture',
    status: 'captured',
    recipientsJson: '{"to":["user@example.com"]}',
    contentJson: '{"subject":"Welcome","text":"Hello"}',
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(bunderstackMessageEvents).values({
    id: 'event_test1',
    messageId: 'message_test1',
    externalId: 'svix_test1',
    type: 'delivered',
    occurredAt: now + 1,
    createdAt: now + 2,
  })

  expect(
    await db
      .select()
      .from(bunderstackMessages)
      .then((rows) => rows.find((row) => row.id === 'message_test1')),
  ).toMatchObject({
    channel: 'email',
    provider: 'resend',
    status: 'captured',
  })
  expect(
    await db
      .select()
      .from(bunderstackMessageEvents)
      .then((rows) => rows.find((row) => row.id === 'event_test1')),
  ).toMatchObject({
    messageId: 'message_test1',
    externalId: 'svix_test1',
    type: 'delivered',
  })
})
