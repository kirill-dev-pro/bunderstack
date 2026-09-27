import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { RPCHandler } from '@orpc/server/fetch'
import { expect, test } from 'bun:test'

import type { ResolvedBucket } from '../storage/buckets'
import type { StorageAdapter } from '../storage/index'
import type { BucketStorageRegistry } from '../storage/registry'

import { buildStorageApiRouter } from '../api/storage-router'
import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { INTERNAL_TABLES } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { getFileMeta } from '../storage/file-meta'
import { createStorageOperations } from '../storage/operations'
import { createClient } from './client'

const PUT_ORIGIN = 'https://storage.test/put/'

// Acts like S3: presigned PUT URLs, and stat() after the direct upload.
class PresignAdapter implements StorageAdapter {
  readonly objects = new Map<string, { bytes: Uint8Array; type: string }>()

  async upload(key: string, data: Blob | ArrayBuffer, type: string) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    this.objects.set(key, { bytes: new Uint8Array(bytes), type })
  }
  async get(key: string) {
    const value = this.objects.get(key)
    return value
      ? new Response(value.bytes as unknown as BodyInit)
      : new Response('Not found', { status: 404 })
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  async exists(key: string) {
    return this.objects.has(key)
  }
  async presignPut(key: string) {
    return `${PUT_ORIGIN}${encodeURIComponent(key)}`
  }
  async stat(key: string) {
    const value = this.objects.get(key)
    return value
      ? { size: value.bytes.byteLength, contentType: value.type }
      : null
  }
}

test('bucket.upload confirms a presigned upload with the bucket-relative id', async () => {
  const { db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  })
  await provisionSchema(db, INTERNAL_TABLES, { force: true })

  const adapter = new PresignAdapter()
  const bucket: ResolvedBucket = {
    name: 'media',
    backend: { type: 'local', path: '/unused' },
    visibility: 'private',
    access: { create: 'authenticated', get: 'owner', delete: 'owner' },
    transforms: false,
  }
  const registry: BucketStorageRegistry = new Map([
    ['media', { bucket, adapter }],
  ])
  const operations = createStorageOperations({
    registry,
    db: db as unknown as LibSQLDatabase<Record<string, unknown>>,
  })
  const rpcHandler = new RPCHandler(
    buildStorageApiRouter(registry, operations) as any,
  )
  const user = { id: 'u1', email: 'u1@test.dev', name: 'u1' }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.startsWith(PUT_ORIGIN)) {
      const key = decodeURIComponent(request.url.slice(PUT_ORIGIN.length))
      await adapter.upload(
        key,
        await request.arrayBuffer(),
        request.headers.get('content-type') ?? '',
      )
      return new Response(null, { status: 200 })
    }
    const { matched, response } = await rpcHandler.handle(request, {
      prefix: '/api/rpc',
      context: {
        request,
        getSession: async () => ({ user, activeOrganizationId: null }),
      } as any,
    })
    return matched ? response : new Response('Not found', { status: 404 })
  }

  const client = createClient<any>({ baseUrl: 'http://app.test/api', fetch })
  const uploaded = await client.files.media!.upload(
    new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }),
  )

  expect(uploaded.fileId).toMatch(/^media\/[0-9a-f-]+\.jpg$/)
  expect(uploaded.name).toBe('photo.jpg')
  expect(uploaded.url).toBe(
    `http://app.test/api/files/${uploaded.fileId.replace('.', '%2E')}`,
  )
  expect((await getFileMeta(db, uploaded.fileId))?.status).toBe('ready')
})
