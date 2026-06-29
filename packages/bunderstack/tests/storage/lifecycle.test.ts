// tests/storage/lifecycle.test.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedBucket } from '../../src/storage/buckets.ts'
import type { BucketStorageRegistry } from '../../src/storage/registry.ts'

import { createDb } from '../../src/db.ts'
import { bunderstackFiles, INTERNAL_TABLES } from '../../src/internal-tables.ts'
import { provisionSchema } from '../../src/provision.ts'
import { deleteFileWithDerivatives } from '../../src/storage/delete.ts'
import {
  getFileMeta,
  insertPendingFile,
  insertReadyFile,
} from '../../src/storage/file-meta.ts'
import { LocalStorageAdapter } from '../../src/storage/local.ts'
import { sweepOrphans } from '../../src/storage/sweep.ts'

let db: ReturnType<typeof createDb<typeof INTERNAL_TABLES>>
let dbAny: LibSQLDatabase<Record<string, unknown>>
let tmp: string
let adapter: LocalStorageAdapter

beforeEach(async () => {
  db = createDb(INTERNAL_TABLES, { url: ':memory:' })
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
  dbAny = db as unknown as LibSQLDatabase<Record<string, unknown>>
  tmp = await mkdtemp(join(tmpdir(), 'bs-lifecycle-'))
  adapter = new LocalStorageAdapter(tmp)
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const bytes = () => new TextEncoder().encode('data').buffer

function bucketEntry(name: string) {
  const bucket = {
    name,
    backend: { type: 'local', path: tmp },
    visibility: 'private',
    access: { create: 'authenticated', get: 'public', delete: 'owner' },
    transforms: true,
  } as ResolvedBucket
  return { bucket, adapter }
}

test('deleteFileWithDerivatives removes original + derivatives + meta row', async () => {
  const fileId = 'files/abc.png'
  await adapter.upload(fileId, bytes(), 'image/png')
  await adapter.upload(`${fileId}__transforms/h1.webp`, bytes(), 'image/webp')
  await adapter.upload(`${fileId}__transforms/h2.webp`, bytes(), 'image/webp')
  await insertReadyFile(dbAny, {
    fileId,
    bucket: 'files',
    ownerId: 'u1',
    scopeJson: null,
    filename: 'abc.png',
    contentType: 'image/png',
    size: 4,
  })

  await deleteFileWithDerivatives(adapter, dbAny, fileId)

  expect(await adapter.exists(fileId)).toBe(false)
  expect(await adapter.exists(`${fileId}__transforms/h1.webp`)).toBe(false)
  expect(await adapter.exists(`${fileId}__transforms/h2.webp`)).toBe(false)
  expect(await getFileMeta(dbAny, fileId)).toBeNull()
})

test('sweepOrphans reaps stale pending only; ready untouched; returns count', async () => {
  const registry: BucketStorageRegistry = new Map([
    ['files', bucketEntry('files')],
  ])

  // Stale pending (object + row).
  const staleId = 'files/stale.bin'
  await adapter.upload(staleId, bytes(), 'application/octet-stream')
  await insertPendingFile(dbAny, {
    fileId: staleId,
    bucket: 'files',
    ownerId: 'u1',
    scopeJson: null,
    filename: null,
    contentType: null,
  })
  // Backdate createdAt to make it stale.
  await dbAny
    .update(bunderstackFiles)
    .set({ createdAt: 1 })
    .where(eq(bunderstackFiles.fileId, staleId))

  // Fresh ready (should survive).
  const readyId = 'files/ready.bin'
  await adapter.upload(readyId, bytes(), 'application/octet-stream')
  await insertReadyFile(dbAny, {
    fileId: readyId,
    bucket: 'files',
    ownerId: 'u1',
    scopeJson: null,
    filename: null,
    contentType: null,
    size: 4,
  })

  const reaped = await sweepOrphans(registry, dbAny, 30 * 60_000)
  expect(reaped).toBe(1)

  expect(await adapter.exists(staleId)).toBe(false)
  expect(await getFileMeta(dbAny, staleId)).toBeNull()
  expect(await adapter.exists(readyId)).toBe(true)
  expect(await getFileMeta(dbAny, readyId)).not.toBeNull()
})
