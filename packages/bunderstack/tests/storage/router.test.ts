// tests/storage/router.test.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { createDb } from '../../src/db'
import { INTERNAL_TABLES } from '../../src/internal-tables'
import { LocalStorageAdapter } from '../../src/storage/local'
import { buildBucketStorageRouter } from '../../src/storage/router'
import type {
  BucketStorage,
  BucketStorageRegistry,
} from '../../src/storage/registry'
import type { ResolvedBucket } from '../../src/storage/buckets'
import type { StorageAdapter } from '../../src/storage/index'
import type { AuthSessionResolver, ScopeMap } from '../../src/access'

// ─── PNG fixture (mirrors thumbnails.test.ts) ───────────────────────────────

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeTestImage(width = 64, height = 64): Buffer {
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(height * rowSize)
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0
    for (let x = 0; x < width; x++) {
      raw[y * rowSize + 1 + x * 3] = 100
      raw[y * rowSize + 1 + x * 3 + 1] = 150
      raw[y * rowSize + 1 + x * 3 + 2] = 200
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── Stub auth ──────────────────────────────────────────────────────────────

const testAuth: AuthSessionResolver = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const userId = headers.get('x-test-user')
      if (!userId) return null
      const org = headers.get('x-test-org')
      return {
        user: { id: userId, email: `${userId}@test.com`, name: 'Test' },
        session: { activeOrganizationId: org ?? null },
      }
    },
  },
}

// ─── In-memory fake S3-like adapter (all optional methods) ──────────────────

class FakeS3Adapter implements StorageAdapter {
  private store = new Map<string, { bytes: Uint8Array; contentType: string }>()

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string) {
    const ab = data instanceof Blob ? await data.arrayBuffer() : data
    this.store.set(fileId, { bytes: new Uint8Array(ab), contentType })
  }
  async get(fileId: string): Promise<Response> {
    const entry = this.store.get(fileId)
    if (!entry) return new Response('Not found', { status: 404 })
    return new Response(entry.bytes, {
      headers: { 'Content-Type': entry.contentType },
    })
  }
  async delete(fileId: string) {
    this.store.delete(fileId)
  }
  async exists(fileId: string) {
    return this.store.has(fileId)
  }
  async presignPut(key: string) {
    return `https://s3.test/put/${encodeURIComponent(key)}`
  }
  async presignGet(key: string) {
    return `https://s3.test/get/${encodeURIComponent(key)}`
  }
  async stat(key: string) {
    const entry = this.store.get(key)
    if (!entry) return null
    return { size: entry.bytes.byteLength, contentType: entry.contentType }
  }
  publicUrlFor(key: string) {
    return `https://cdn.test/${key}`
  }

  // test seam: simulate a direct PUT to the presigned URL
  async _putDirect(key: string, bytes: Uint8Array, contentType: string) {
    this.store.set(key, { bytes, contentType })
  }
}

// ─── Bucket builders ────────────────────────────────────────────────────────

function localBucket(
  name: string,
  adapter: StorageAdapter,
  over: Partial<ResolvedBucket> = {},
): BucketStorage {
  const bucket: ResolvedBucket = {
    name,
    backend: { type: 'local', path: '/tmp/ignored' },
    visibility: 'private',
    access: { create: 'authenticated', get: 'public', delete: 'owner' },
    transforms: false,
    ...over,
  }
  return { bucket, adapter }
}

function s3Bucket(
  name: string,
  adapter: StorageAdapter,
  over: Partial<ResolvedBucket> = {},
): BucketStorage {
  const bucket: ResolvedBucket = {
    name,
    backend: {
      type: 's3',
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
    },
    visibility: 'private',
    access: { create: 'authenticated', get: 'public', delete: 'owner' },
    transforms: false,
    ...over,
  }
  return { bucket, adapter }
}

// ─── Harness ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof createDb<typeof INTERNAL_TABLES>>
let app: Hono
let local: LocalStorageAdapter
let fake: FakeS3Adapter
let tmp: string

async function makeApp(registry: BucketStorageRegistry, defaultBucket: string) {
  app = new Hono()
  app.route(
    '/api/files',
    buildBucketStorageRouter({
      registry,
      defaultBucket,
      db: db as unknown as LibSQLDatabase<Record<string, unknown>>,
      auth: testAuth,
    }),
  )
}

beforeEach(async () => {
  db = createDb(INTERNAL_TABLES, { url: ':memory:' })
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS bunderstack_file_meta (
      file_id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      owner_id TEXT,
      scope_json TEXT,
      status TEXT NOT NULL,
      filename TEXT,
      content_type TEXT,
      size INTEGER,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER
    )`,
  )
  tmp = await mkdtemp(join(tmpdir(), 'bs-router-'))
  local = new LocalStorageAdapter(tmp)
  fake = new FakeS3Adapter()
})

// ─── Tests ──────────────────────────────────────────────────────────────────

test('unknown bucket → 404', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const res = await app.request('/api/files/nope/x', {
    headers: { 'x-test-user': 'u1' },
  })
  expect(res.status).toBe(404)
})

test('proxy upload happy path → 201, row ready, size stored', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['hello world'], 'a.txt', { type: 'text/plain' }))
  const res = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: form,
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { fileId: string; url: string }
  expect(body.fileId.startsWith('files/')).toBe(true)
  const id = body.fileId.slice('files/'.length)
  expect(body.url).toBe(`/api/files/files/${id}`)
  // row is ready w/ size
  const get = await app.request(body.url, { headers: { 'x-test-user': 'u1' } })
  expect(get.status).toBe(200)
})

test('proxy upload missing file → 400', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('notfile', 'x')
  const res = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: form,
  })
  expect(res.status).toBe(400)
})

test('proxy upload oversize → 422', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['files', localBucket('files', local, { upload: { maxSizeBytes: 5 } })],
  ])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['way too long'], 'a.txt', { type: 'text/plain' }))
  const res = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: form,
  })
  expect(res.status).toBe(422)
})

test('proxy upload disallowed mime → 422; image/* wildcard accepted', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['files', localBucket('files', local, { upload: { accept: ['image/*'] } })],
  ])
  await makeApp(reg, 'files')

  const bad = new FormData()
  bad.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
  const r1 = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: bad,
  })
  expect(r1.status).toBe(422)

  const good = new FormData()
  good.append('file', new File([makeTestImage()], 'a.png', { type: 'image/png' }))
  const r2 = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: good,
  })
  expect(r2.status).toBe(201)
})

test('create denied for anon when create:authenticated → 401', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
  const res = await app.request('/api/files/files', { method: 'POST', body: form })
  expect(res.status).toBe(401)
})

test('get on owner-private file by non-owner → 403; owner allowed', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['files', localBucket('files', local, { access: { create: 'authenticated', get: 'owner', delete: 'owner' } })],
  ])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['secret'], 'a.txt', { type: 'text/plain' }))
  const up = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'owner1' },
    body: form,
  })
  const { url } = (await up.json()) as { url: string }

  const other = await app.request(url, { headers: { 'x-test-user': 'intruder' } })
  expect(other.status).toBe(403)

  const owner = await app.request(url, { headers: { 'x-test-user': 'owner1' } })
  expect(owner.status).toBe(200)
})

test('scope: file in org A not visible to org B (404); same org visible', async () => {
  const scope = (ctx: { session?: { activeOrganizationId: string | null } | null }): ScopeMap => ({
    orgId: ctx.session?.activeOrganizationId ?? 'none',
  })
  const reg: BucketStorageRegistry = new Map([
    ['files', localBucket('files', local, { scope: scope as ResolvedBucket['scope'] })],
  ])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
  const up = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'x-test-org': 'orgA' },
    body: form,
  })
  const { url } = (await up.json()) as { url: string }

  const b = await app.request(url, {
    headers: { 'x-test-user': 'u2', 'x-test-org': 'orgB' },
  })
  expect(b.status).toBe(404)

  const a = await app.request(url, {
    headers: { 'x-test-user': 'u2', 'x-test-org': 'orgA' },
  })
  expect(a.status).toBe(200)
})

test('quota perUser blocks proxy upload (413); under limit allowed', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['files', localBucket('files', local, { quota: { perUserBytes: 10 } })],
  ])
  await makeApp(reg, 'files')

  const f1 = new FormData()
  f1.append('file', new File(['12345678'], 'a.txt', { type: 'text/plain' })) // 8 bytes
  const r1 = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: f1,
  })
  expect(r1.status).toBe(201)

  const f2 = new FormData()
  f2.append('file', new File(['12345'], 'b.txt', { type: 'text/plain' })) // 5 bytes → 13 > 10
  const r2 = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: f2,
  })
  expect(r2.status).toBe(413)
})

test('presign (fake-S3): mode presign + pending row; confirm flips to ready', async () => {
  const reg: BucketStorageRegistry = new Map([['photos', s3Bucket('photos', fake)]])
  await makeApp(reg, 'photos')

  const pres = await app.request('/api/files/photos/presign', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'p.png', contentType: 'image/png' }),
  })
  expect(pres.status).toBe(200)
  const pj = (await pres.json()) as {
    mode: string
    fileId: string
    uploadUrl: string
    method: string
    confirmUrl: string
  }
  expect(pj.mode).toBe('presign')
  expect(pj.method).toBe('PUT')
  expect(pj.uploadUrl).toContain(encodeURIComponent(pj.fileId))
  const id = pj.fileId.slice('photos/'.length)
  expect(pj.confirmUrl).toBe(`/api/files/photos/${id}/confirm`)

  // simulate the direct PUT
  await fake._putDirect(pj.fileId, new Uint8Array([1, 2, 3, 4]), 'image/png')

  const conf = await app.request(pj.confirmUrl, {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
  })
  expect(conf.status).toBe(200)
  const cj = (await conf.json()) as { fileId: string; url: string }
  expect(cj.url).toBe(`/api/files/photos/${id}`)

  // confirm idempotent
  const conf2 = await app.request(pj.confirmUrl, {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
  })
  expect(conf2.status).toBe(200)
})

test('confirm oversize → 413 + row/object gone', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['photos', s3Bucket('photos', fake, { upload: { maxSizeBytes: 2 } })],
  ])
  await makeApp(reg, 'photos')

  const pres = await app.request('/api/files/photos/presign', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'p.png', contentType: 'image/png' }),
  })
  const pj = (await pres.json()) as { fileId: string; confirmUrl: string }
  await fake._putDirect(pj.fileId, new Uint8Array([1, 2, 3, 4, 5]), 'image/png')

  const conf = await app.request(pj.confirmUrl, {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
  })
  expect(conf.status).toBe(413)
  expect(await fake.exists(pj.fileId)).toBe(false)
})

test('presign on local bucket → mode proxy, no row created', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const res = await app.request('/api/files/files/presign', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'a.txt' }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { mode: string; uploadUrl: string }
  expect(body.mode).toBe('proxy')
  expect(body.uploadUrl).toBe('/api/files/files')
})

test('GET private fake-S3 ready → 302 to presignGet URL', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['photos', s3Bucket('photos', fake, { visibility: 'private', access: { create: 'authenticated', get: 'public', delete: 'owner' } })],
  ])
  await makeApp(reg, 'photos')

  const pres = await app.request('/api/files/photos/presign', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'p.png', contentType: 'image/png' }),
  })
  const pj = (await pres.json()) as { fileId: string; confirmUrl: string }
  await fake._putDirect(pj.fileId, new Uint8Array([1, 2, 3]), 'image/png')
  await app.request(pj.confirmUrl, { method: 'POST', headers: { 'x-test-user': 'u1' } })

  const id = pj.fileId.slice('photos/'.length)
  const get = await app.request(`/api/files/photos/${id}`, {
    headers: { 'x-test-user': 'u1' },
    redirect: 'manual',
  })
  expect(get.status).toBe(302)
  expect(get.headers.get('location')).toBe(await fake.presignGet(pj.fileId))
})

test('GET public fake-S3 ready → 302 to publicUrlFor URL', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['photos', s3Bucket('photos', fake, { visibility: 'public', access: { create: 'authenticated', get: 'public', delete: 'owner' } })],
  ])
  await makeApp(reg, 'photos')

  const pres = await app.request('/api/files/photos/presign', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'p.png', contentType: 'image/png' }),
  })
  const pj = (await pres.json()) as { fileId: string; confirmUrl: string }
  await fake._putDirect(pj.fileId, new Uint8Array([1, 2, 3]), 'image/png')
  await app.request(pj.confirmUrl, { method: 'POST', headers: { 'x-test-user': 'u1' } })

  const id = pj.fileId.slice('photos/'.length)
  const get = await app.request(`/api/files/photos/${id}`, {
    headers: { 'x-test-user': 'u1' },
    redirect: 'manual',
  })
  expect(get.status).toBe(302)
  expect(get.headers.get('location')).toBe(`https://cdn.test/${pj.fileId}`)
})

test('GET local with filename → Content-Disposition header present', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['hi'], 'my report.txt', { type: 'text/plain' }))
  const up = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: form,
  })
  const { url } = (await up.json()) as { url: string }
  const get = await app.request(url, { headers: { 'x-test-user': 'u1' } })
  expect(get.status).toBe(200)
  const cd = get.headers.get('content-disposition')
  expect(cd).toContain('inline')
  expect(cd).toContain('my report.txt')
})

test('transforms: ?w=32 on transforms:true bucket returns bytes + caches', async () => {
  const reg: BucketStorageRegistry = new Map([
    ['images', localBucket('images', local, { transforms: true, upload: { accept: ['image/*'] } })],
  ])
  await makeApp(reg, 'images')
  const form = new FormData()
  form.append('file', new File([makeTestImage(64, 64)], 'a.png', { type: 'image/png' }))
  const up = await app.request('/api/files/images', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: form,
  })
  const { url } = (await up.json()) as { url: string }
  const get = await app.request(`${url}?w=32`, { headers: { 'x-test-user': 'u1' } })
  expect(get.status).toBe(200)
  const buf = Buffer.from(await get.arrayBuffer())
  const meta = await new Bun.Image(buf).metadata()
  expect(meta.width).toBe(32)
  // second hit served from cache
  const again = await app.request(`${url}?w=32`, { headers: { 'x-test-user': 'u1' } })
  expect(again.status).toBe(200)
})

test('transforms spec on transforms:false bucket → 400', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File([makeTestImage()], 'a.png', { type: 'image/png' }))
  const up = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
    body: form,
  })
  const { url } = (await up.json()) as { url: string }
  const get = await app.request(`${url}?w=32`, { headers: { 'x-test-user': 'u1' } })
  expect(get.status).toBe(400)
})

test('DELETE: owner deletes (204, gone); non-owner 403; missing 404', async () => {
  const reg: BucketStorageRegistry = new Map([['files', localBucket('files', local)]])
  await makeApp(reg, 'files')
  const form = new FormData()
  form.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
  const up = await app.request('/api/files/files', {
    method: 'POST',
    headers: { 'x-test-user': 'owner1' },
    body: form,
  })
  const { url, fileId } = (await up.json()) as { url: string; fileId: string }

  const nonOwner = await app.request(url, {
    method: 'DELETE',
    headers: { 'x-test-user': 'intruder' },
  })
  expect(nonOwner.status).toBe(403)

  const del = await app.request(url, {
    method: 'DELETE',
    headers: { 'x-test-user': 'owner1' },
  })
  expect(del.status).toBe(204)
  expect(await local.exists(fileId)).toBe(false)

  const missing = await app.request('/api/files/files/does-not-exist.txt', {
    method: 'DELETE',
    headers: { 'x-test-user': 'owner1' },
  })
  expect(missing.status).toBe(404)
})

test('confirm: never-uploaded → 404', async () => {
  const reg: BucketStorageRegistry = new Map([['photos', s3Bucket('photos', fake)]])
  await makeApp(reg, 'photos')
  const pres = await app.request('/api/files/photos/presign', {
    method: 'POST',
    headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'p.png', contentType: 'image/png' }),
  })
  const pj = (await pres.json()) as { confirmUrl: string }
  const conf = await app.request(pj.confirmUrl, {
    method: 'POST',
    headers: { 'x-test-user': 'u1' },
  })
  expect(conf.status).toBe(404)
})
