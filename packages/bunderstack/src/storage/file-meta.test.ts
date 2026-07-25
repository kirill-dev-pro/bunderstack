import { test, expect, beforeAll } from 'bun:test'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackFiles, INTERNAL_TABLES } from '../internal-tables'
import { provisionSchema } from '../provision'
import {
  insertPendingFile,
  insertReadyFile,
  markFileReady,
  getFileMeta,
  deleteFileMetaRow,
  listStalePendingFiles,
  sumReadySize,
  scopeToJson,
  parseScopeJson,
  fileMatchesScope,
} from './file-meta'

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']

beforeAll(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
})

// ─── insertPendingFile + getFileMeta ───────────────────────────────────────

test('insertPendingFile: status=pending, size=null, confirmedAt=null, createdAt is a number', async () => {
  await insertPendingFile(db, {
    fileId: 'file-pending-1',
    bucket: 'docs',
    ownerId: 'user-1',
    scopeJson: null,
    filename: 'report.pdf',
    contentType: 'application/pdf',
  })

  const row = await getFileMeta(db, 'file-pending-1')
  expect(row).not.toBeNull()
  expect(row!.status).toBe('pending')
  expect(row!.size).toBeNull()
  expect(row!.confirmedAt).toBeNull()
  expect(typeof row!.createdAt).toBe('number')
  expect(row!.createdAt).toBeGreaterThan(0)
  expect(row!.bucket).toBe('docs')
  expect(row!.ownerId).toBe('user-1')
  expect(row!.filename).toBe('report.pdf')
  expect(row!.contentType).toBe('application/pdf')
})

// ─── insertReadyFile ───────────────────────────────────────────────────────

test('insertReadyFile: status=ready, confirmedAt set, size stored', async () => {
  await insertReadyFile(db, {
    fileId: 'file-ready-1',
    bucket: 'avatars',
    ownerId: 'user-2',
    scopeJson: null,
    filename: 'avatar.png',
    contentType: 'image/png',
    size: 4096,
  })

  const row = await getFileMeta(db, 'file-ready-1')
  expect(row).not.toBeNull()
  expect(row!.status).toBe('ready')
  expect(row!.size).toBe(4096)
  expect(typeof row!.confirmedAt).toBe('number')
  expect(row!.confirmedAt).toBeGreaterThan(0)
})

// ─── markFileReady ─────────────────────────────────────────────────────────

test('markFileReady: flips pending row to ready and sets size/contentType/confirmedAt', async () => {
  await insertPendingFile(db, {
    fileId: 'file-flip-1',
    bucket: 'docs',
    ownerId: 'user-3',
    scopeJson: null,
    filename: 'doc.txt',
    contentType: null,
  })

  let row = await getFileMeta(db, 'file-flip-1')
  expect(row!.status).toBe('pending')
  expect(row!.confirmedAt).toBeNull()

  await markFileReady(db, 'file-flip-1', {
    size: 1234,
    contentType: 'text/plain',
  })

  row = await getFileMeta(db, 'file-flip-1')
  expect(row!.status).toBe('ready')
  expect(row!.size).toBe(1234)
  expect(row!.contentType).toBe('text/plain')
  expect(typeof row!.confirmedAt).toBe('number')
  expect(row!.confirmedAt).toBeGreaterThan(0)
})

// ─── deleteFileMetaRow ─────────────────────────────────────────────────────

test('deleteFileMetaRow: removes the row, getFileMeta returns null', async () => {
  await insertPendingFile(db, {
    fileId: 'file-del-1',
    bucket: 'docs',
    ownerId: 'user-4',
    scopeJson: null,
    filename: null,
    contentType: null,
  })

  let row = await getFileMeta(db, 'file-del-1')
  expect(row).not.toBeNull()

  await deleteFileMetaRow(db, 'file-del-1')

  row = await getFileMeta(db, 'file-del-1')
  expect(row).toBeNull()
})

// ─── getFileMeta: non-existent returns null ────────────────────────────────

test('getFileMeta: non-existent fileId returns null', async () => {
  const row = await getFileMeta(db, 'does-not-exist')
  expect(row).toBeNull()
})

// ─── listStalePendingFiles ─────────────────────────────────────────────────

test('listStalePendingFiles: returns only pending rows older than cutoff', async () => {
  const oldTime = Date.now() - 999_999
  const recentTime = Date.now()

  // stale pending
  await db.insert(bunderstackFiles).values({
    fileId: 'file-stale-1',
    bucket: 'docs',
    ownerId: 'user-sweep',
    status: 'pending',
    createdAt: oldTime,
  })

  // recent ready — should not appear
  await db.insert(bunderstackFiles).values({
    fileId: 'file-fresh-ready-1',
    bucket: 'docs',
    ownerId: 'user-sweep',
    status: 'ready',
    createdAt: recentTime,
    confirmedAt: recentTime,
  })

  // stale ready — status mismatch, should not appear
  await db.insert(bunderstackFiles).values({
    fileId: 'file-stale-ready-1',
    bucket: 'docs',
    ownerId: 'user-sweep',
    status: 'ready',
    createdAt: oldTime,
    confirmedAt: oldTime,
  })

  // cutoff = oldTime + 1 (so stale pending falls below, recent pending does not)
  const stale = await listStalePendingFiles(db, oldTime + 1)
  const ids = stale.map((r) => r.fileId)
  expect(ids).toContain('file-stale-1')
  // should not contain any ready rows
  for (const row of stale) {
    expect(row.status).toBe('pending')
  }
  expect(ids).not.toContain('file-fresh-ready-1')
  expect(ids).not.toContain('file-stale-ready-1')
})

// ─── sumReadySize by ownerId ───────────────────────────────────────────────

test('sumReadySize: sums only ready files for the given owner+bucket', async () => {
  const now = Date.now()

  // owner A: two ready files, sizes 100 + 200
  await db.insert(bunderstackFiles).values({
    fileId: 'quota-a-1',
    bucket: 'quota-bucket',
    ownerId: 'quota-owner-a',
    status: 'ready',
    size: 100,
    createdAt: now,
    confirmedAt: now,
  })
  await db.insert(bunderstackFiles).values({
    fileId: 'quota-a-2',
    bucket: 'quota-bucket',
    ownerId: 'quota-owner-a',
    status: 'ready',
    size: 200,
    createdAt: now,
    confirmedAt: now,
  })

  // owner B: should not be included
  await db.insert(bunderstackFiles).values({
    fileId: 'quota-b-1',
    bucket: 'quota-bucket',
    ownerId: 'quota-owner-b',
    status: 'ready',
    size: 500,
    createdAt: now,
    confirmedAt: now,
  })

  // owner A pending: should not be included
  await db.insert(bunderstackFiles).values({
    fileId: 'quota-a-pending',
    bucket: 'quota-bucket',
    ownerId: 'quota-owner-a',
    status: 'pending',
    size: 999,
    createdAt: now,
  })

  const sumA = await sumReadySize(db, {
    bucket: 'quota-bucket',
    ownerId: 'quota-owner-a',
  })
  expect(sumA).toBe(300)
  expect(typeof sumA).toBe('number')

  // wrong bucket
  const sumWrongBucket = await sumReadySize(db, {
    bucket: 'other-bucket',
    ownerId: 'quota-owner-a',
  })
  expect(sumWrongBucket).toBe(0)
})

// ─── sumReadySize by scopeJson ─────────────────────────────────────────────

test('sumReadySize: sums by scopeJson, respects bucket filter', async () => {
  const now = Date.now()
  const scope = scopeToJson({ orgId: 'org-123' })

  await db.insert(bunderstackFiles).values({
    fileId: 'scope-q-1',
    bucket: 'scope-bucket',
    ownerId: null,
    scopeJson: scope,
    status: 'ready',
    size: 400,
    createdAt: now,
    confirmedAt: now,
  })
  await db.insert(bunderstackFiles).values({
    fileId: 'scope-q-2',
    bucket: 'scope-bucket',
    ownerId: null,
    scopeJson: scope,
    status: 'ready',
    size: 600,
    createdAt: now,
    confirmedAt: now,
  })

  // different scope — should not be included
  const otherScope = scopeToJson({ orgId: 'org-999' })
  await db.insert(bunderstackFiles).values({
    fileId: 'scope-q-other',
    bucket: 'scope-bucket',
    ownerId: null,
    scopeJson: otherScope,
    status: 'ready',
    size: 1000,
    createdAt: now,
    confirmedAt: now,
  })

  const total = await sumReadySize(db, {
    bucket: 'scope-bucket',
    scopeJson: scope!,
  })
  expect(total).toBe(1000)
  expect(typeof total).toBe('number')
})

// ─── sumReadySize: COALESCE → 0 when no rows ──────────────────────────────

test('sumReadySize: returns 0 (not null/undefined) when no matching rows', async () => {
  const result = await sumReadySize(db, {
    bucket: 'empty-bucket',
    ownerId: 'ghost-user',
  })
  expect(result).toBe(0)
  expect(typeof result).toBe('number')
})

// ─── sumReadySize: both owner + scope filters (AND) ───────────────────────

test('sumReadySize: AND-combines ownerId and scopeJson filters', async () => {
  const now = Date.now()
  const scope = scopeToJson({ orgId: 'org-combo' })

  // matches both
  await db.insert(bunderstackFiles).values({
    fileId: 'combo-1',
    bucket: 'combo-bucket',
    ownerId: 'combo-owner',
    scopeJson: scope,
    status: 'ready',
    size: 111,
    createdAt: now,
    confirmedAt: now,
  })
  // right scope, wrong owner — should NOT match
  await db.insert(bunderstackFiles).values({
    fileId: 'combo-2',
    bucket: 'combo-bucket',
    ownerId: 'other-owner',
    scopeJson: scope,
    status: 'ready',
    size: 222,
    createdAt: now,
    confirmedAt: now,
  })

  const total = await sumReadySize(db, {
    bucket: 'combo-bucket',
    ownerId: 'combo-owner',
    scopeJson: scope!,
  })
  expect(total).toBe(111)
})

// ─── scopeToJson ──────────────────────────────────────────────────────────

test('scopeToJson: null/undefined/empty-object returns null', () => {
  expect(scopeToJson(null)).toBeNull()
  expect(scopeToJson(undefined)).toBeNull()
  expect(scopeToJson({})).toBeNull()
})

test('scopeToJson: key-order independence — two orderings produce identical string', () => {
  const a = scopeToJson({ a: '1', b: '2' })
  const b = scopeToJson({ b: '2', a: '1' })
  expect(a).not.toBeNull()
  expect(a).toBe(b)
})

test('scopeToJson: deterministic output', () => {
  const result = scopeToJson({ orgId: 'org-1', tenantId: 'tenant-2' })
  expect(result).toBe('{"orgId":"org-1","tenantId":"tenant-2"}')
})

// ─── parseScopeJson ────────────────────────────────────────────────────────

test('parseScopeJson: round-trips through scopeToJson', () => {
  const original = { orgId: 'org-1', tenantId: 'tenant-2' }
  const json = scopeToJson(original)
  const parsed = parseScopeJson(json)
  expect(parsed).toEqual(original)
})

test('parseScopeJson: null input returns null', () => {
  expect(parseScopeJson(null)).toBeNull()
})

// ─── fileMatchesScope ─────────────────────────────────────────────────────

test('fileMatchesScope: undefined requesterScope → true (bucket not scoped)', async () => {
  await insertReadyFile(db, {
    fileId: 'match-scope-1',
    bucket: 'unscoped-bucket',
    ownerId: 'user-x',
    scopeJson: null,
    filename: null,
    contentType: null,
    size: null,
  })
  const row = await getFileMeta(db, 'match-scope-1')
  expect(fileMatchesScope(row!, undefined)).toBe(true)
})

test('fileMatchesScope: empty-object requesterScope → true', async () => {
  const row = await getFileMeta(db, 'match-scope-1')
  expect(fileMatchesScope(row!, {})).toBe(true)
})

test('fileMatchesScope: matching scope returns true', async () => {
  const scope = { orgId: 'org-abc' }
  await insertReadyFile(db, {
    fileId: 'match-scope-2',
    bucket: 'scoped-bucket',
    ownerId: 'user-y',
    scopeJson: scopeToJson(scope),
    filename: null,
    contentType: null,
    size: null,
  })
  const row = await getFileMeta(db, 'match-scope-2')
  expect(fileMatchesScope(row!, scope)).toBe(true)
})

test('fileMatchesScope: mismatched scope returns false', async () => {
  const row = await getFileMeta(db, 'match-scope-2')
  expect(fileMatchesScope(row!, { orgId: 'org-xyz' })).toBe(false)
})

test('fileMatchesScope: null scopeJson under scoped requester → false', async () => {
  // file-pending-1 was inserted with scopeJson=null
  const row = await getFileMeta(db, 'file-pending-1')
  expect(row!.scopeJson).toBeNull()
  expect(fileMatchesScope(row!, { orgId: 'org-abc' })).toBe(false)
})
