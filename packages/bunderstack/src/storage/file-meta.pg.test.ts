// src/storage/file-meta.pg.test.ts — internal-table dispatch on a real PGlite db.
import { test, expect, beforeAll } from 'bun:test'
import { sql } from 'drizzle-orm'

import type { AnyDb } from '../dialect'

import {
  getFileMeta,
  insertPendingFile,
  markFileReady,
  sumReadySize,
} from './file-meta'
import { lookupIdempotency, storeIdempotency } from '../idempotency'

let db: AnyDb & { execute: (q: unknown) => Promise<unknown> }

beforeAll(async () => {
  const { drizzle } = await import('drizzle-orm/pglite')
  const pgdb = drizzle('memory://')
  await pgdb.execute(sql`
    CREATE TABLE bunderstack_file_meta (
      file_id text PRIMARY KEY, bucket text NOT NULL, owner_id text,
      scope_json text, status text NOT NULL, filename text,
      content_type text, size bigint, created_at bigint NOT NULL,
      confirmed_at bigint
    )`)
  await pgdb.execute(sql`
    CREATE TABLE _bunderstack_idempotency (
      key text NOT NULL, table_name text NOT NULL, body_hash text NOT NULL,
      status integer NOT NULL, response text NOT NULL, expires_at bigint NOT NULL,
      PRIMARY KEY (key, table_name)
    )`)
  db = pgdb as unknown as typeof db
})

test('file-meta round-trips on Postgres', async () => {
  await insertPendingFile(db, {
    fileId: 'avatars/f1',
    bucket: 'avatars',
    ownerId: 'u1',
    scopeJson: null,
    filename: 'a.png',
    contentType: 'image/png',
  })
  await markFileReady(db, 'avatars/f1', { size: 123, contentType: 'image/png' })
  const row = await getFileMeta(db, 'avatars/f1')
  expect(row?.status).toBe('ready')
  expect(Number(row?.size)).toBe(123)
  expect(await sumReadySize(db, { bucket: 'avatars', ownerId: 'u1' })).toBe(123)
})

test('idempotency replay works on Postgres (onConflictDoUpdate)', async () => {
  await storeIdempotency(db, 'posts', 'k1', '{"a":1}', 201, { id: 1 }, {})
  // Upsert path: same key, new response.
  await storeIdempotency(db, 'posts', 'k1', '{"a":1}', 201, { id: 2 }, {})
  const hit = await lookupIdempotency(db, 'posts', 'k1', '{"a":1}', {})
  expect(hit).toEqual({ type: 'replay', status: 201, response: '{"id":2}' })
  const conflict = await lookupIdempotency(db, 'posts', 'k1', '{"a":2}', {})
  expect(conflict).toEqual({ type: 'conflict' })
})
