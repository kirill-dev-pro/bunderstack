import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeEach, expect, test } from 'bun:test'

import type { ResolvedBucket } from './buckets'
import type { StorageAdapter } from './index'
import type { BucketStorageRegistry } from './registry'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { BunderstackError } from '../errors'
import { INTERNAL_TABLES } from '../internal-tables'
import { getFileMeta } from './file-meta'
import { createStorageOperations } from './operations'

class MemoryAdapter implements StorageAdapter {
  readonly objects = new Map<string, { bytes: Uint8Array; type: string }>()

  async upload(key: string, data: Blob | ArrayBuffer, type: string) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    this.objects.set(key, { bytes: new Uint8Array(bytes), type })
  }
  async get(key: string) {
    const value = this.objects.get(key)
    return value
      ? new Response(value.bytes as unknown as BodyInit, {
          headers: { 'Content-Type': value.type },
        })
      : new Response('Not found', { status: 404 })
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  async exists(key: string) {
    return this.objects.has(key)
  }
}

class PresignAdapter extends MemoryAdapter {
  async presignPut(key: string) {
    return `https://storage.test/put/${encodeURIComponent(key)}`
  }
  async presignGet(key: string) {
    return `https://storage.test/get/${encodeURIComponent(key)}`
  }
  async stat(key: string) {
    const value = this.objects.get(key)
    return value
      ? { size: value.bytes.byteLength, contentType: value.type }
      : null
  }
  publicUrlFor(key: string) {
    return `https://cdn.test/${key}`
  }
}

const bucket = (_adapter: StorageAdapter): ResolvedBucket => ({
  name: 'docs',
  backend: { type: 'local', path: '/unused' },
  visibility: 'private',
  access: { create: 'authenticated', get: 'owner', delete: 'owner' },
  transforms: false,
})

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']
let adapter: MemoryAdapter
let operations: ReturnType<typeof createStorageOperations>

function operationsFor(
  storageAdapter: StorageAdapter,
  overrides: Partial<ResolvedBucket> = {},
) {
  const registry: BucketStorageRegistry = new Map([
    [
      'docs',
      {
        bucket: { ...bucket(storageAdapter), ...overrides },
        adapter: storageAdapter,
      },
    ],
  ])
  return createStorageOperations({
    registry,
    db: db as unknown as LibSQLDatabase<Record<string, unknown>>,
  })
}

beforeEach(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
  await (
    db as unknown as { $client: { execute: (sql: string) => Promise<unknown> } }
  ).$client.execute(`CREATE TABLE bunderstack_file_meta (
    file_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, owner_id TEXT,
    scope_json TEXT, status TEXT NOT NULL, filename TEXT, content_type TEXT,
    size INTEGER, created_at INTEGER NOT NULL, confirmed_at INTEGER
  )`)
  adapter = new MemoryAdapter()
  operations = operationsFor(adapter)
})

const context = (userId: string | null) => ({
  request: new Request('http://localhost/api/files/docs'),
  user: userId
    ? { id: userId, email: `${userId}@test.dev`, name: userId }
    : null,
  session: { activeOrganizationId: null },
})

test('proxy upload stores bytes and metadata without HTTP framework types', async () => {
  const result = await operations.upload(
    'docs',
    new File(['hello'], 'hello.txt', { type: 'text/plain' }),
    context('u1'),
  )

  expect(result.status).toBe(201)
  expect(result.fileId.startsWith('docs/')).toBe(true)
  expect(await adapter.get(result.fileId).then((res) => res.text())).toBe(
    'hello',
  )
  expect((await getFileMeta(db, result.fileId))?.ownerId).toBe('u1')
})

test('access failures use the shared strict error model', async () => {
  expect(
    operations.upload(
      'docs',
      new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      context(null),
    ),
  ).rejects.toEqual(expect.any(BunderstackError))
  expect(
    operations.upload(
      'missing',
      new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      context('u1'),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('prepare selects proxy locally and creates pending metadata for presign', async () => {
  expect(await operations.prepareUpload('docs', {}, context('u1'))).toEqual({
    mode: 'proxy',
    uploadUrl: '/api/files/docs',
  })

  const direct = new PresignAdapter()
  const directOperations = operationsFor(direct)
  const prepared = await directOperations.prepareUpload(
    'docs',
    { filename: 'report.pdf', contentType: 'application/pdf' },
    context('u1'),
  )
  expect(prepared).toMatchObject({
    mode: 'presign',
    method: 'PUT',
  })
  if (prepared.mode !== 'presign') throw new Error('expected presign')
  expect((await getFileMeta(db, prepared.fileId))?.status).toBe('pending')

  await direct.upload(
    prepared.fileId,
    new TextEncoder().encode('pdf').buffer,
    'application/pdf',
  )
  const id = prepared.fileId.slice('docs/'.length)
  expect(
    await directOperations.confirmUpload('docs', id, context('u1')),
  ).toEqual({ fileId: prepared.fileId, url: `/api/files/docs/${id}` })
  expect((await getFileMeta(db, prepared.fileId))?.status).toBe('ready')
})

test('upload enforces MIME, size, and per-user quota', async () => {
  const limited = operationsFor(adapter, {
    upload: { accept: ['text/*'], maxSizeBytes: 5 },
    quota: { perUserBytes: 6 },
  })

  await expect(
    limited.upload(
      'docs',
      new File(['x'], 'x.png', { type: 'image/png' }),
      context('u1'),
    ),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(
    limited.upload(
      'docs',
      new File(['123456'], 'x.txt', { type: 'text/plain' }),
      context('u1'),
    ),
  ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })

  await limited.upload(
    'docs',
    new File(['1234'], 'a.txt', { type: 'text/plain' }),
    context('u1'),
  )
  await expect(
    limited.upload(
      'docs',
      new File(['123'], 'b.txt', { type: 'text/plain' }),
      context('u1'),
    ),
  ).rejects.toMatchObject({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Quota exceeded',
  })
})

test('download applies owner access, returns proxy bytes, and delete cleans metadata', async () => {
  const uploaded = await operations.upload(
    'docs',
    new File(['private'], 'my report.txt', { type: 'text/plain' }),
    context('u1'),
  )
  const id = uploaded.fileId.slice('docs/'.length)

  await expect(
    operations.download('docs', id, {}, context('u2')),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const downloaded = await operations.download('docs', id, {}, context('u1'))
  expect(downloaded.kind).toBe('body')
  if (downloaded.kind !== 'body') throw new Error('expected body')
  expect(new Response(downloaded.body).text()).resolves.toBe('private')
  expect(downloaded.headers.get('Content-Disposition')).toContain(
    'my report.txt',
  )

  await operations.delete('docs', id, context('u1'))
  expect(await getFileMeta(db, uploaded.fileId)).toBeNull()
  expect(adapter.objects.has(uploaded.fileId)).toBe(false)
})

test('private presigned and public buckets return redirects', async () => {
  const direct = new PresignAdapter()
  const privateOperations = operationsFor(direct)
  const uploaded = await privateOperations.upload(
    'docs',
    new File(['x'], 'x.txt', { type: 'text/plain' }),
    context('u1'),
  )
  const id = uploaded.fileId.slice('docs/'.length)
  expect(
    await privateOperations.download('docs', id, {}, context('u1')),
  ).toMatchObject({
    kind: 'redirect',
    url: expect.stringContaining('https://storage.test/get/'),
  })

  const publicOperations = operationsFor(direct, {
    visibility: 'public',
    access: { create: 'authenticated', get: 'public', delete: 'owner' },
  })
  expect(
    await publicOperations.download('docs', id, {}, context(null)),
  ).toEqual({
    kind: 'redirect',
    status: 302,
    url: `https://cdn.test/${uploaded.fileId}`,
  })
})
