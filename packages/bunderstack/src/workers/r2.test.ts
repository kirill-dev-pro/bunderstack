import { expect, test } from 'bun:test'

import type { ResolvedBucket } from '../storage/buckets'

import { S3StorageAdapter } from '../storage/s3'
import { createFakeR2 } from '../testing/workers-fakes'
import { bucketBindingName, R2StorageAdapter, workerStorageFactory } from './r2'

const bucket = (
  name: string,
  backend: ResolvedBucket['backend'],
): ResolvedBucket => ({
  name,
  backend,
  visibility: 'private',
  access: { create: 'authenticated', get: 'owner', delete: 'owner' },
  transforms: false,
})

const s3Backend = {
  type: 's3' as const,
  bucket: 'b',
  region: 'auto',
  accessKeyId: 'k',
  secretAccessKey: 's',
  endpoint: 'https://r2.example.test',
}
const localBackend = { type: 'local' as const, path: './uploads' }

test('bucketBindingName follows the wrangler.json convention', () => {
  expect(bucketBindingName('media')).toBe('BUCKET_MEDIA')
  expect(bucketBindingName('user-avatars')).toBe('BUCKET_USER_AVATARS')
})

test('R2 adapter stores, reads, stats, lists, and deletes', async () => {
  const adapter = new R2StorageAdapter(createFakeR2())
  await adapter.upload(
    'media/a.png',
    new TextEncoder().encode('png').buffer,
    'image/png',
  )
  for (const n of [1, 2, 3]) {
    await adapter.upload(
      `media/a.png__transforms/${n}.webp`,
      new ArrayBuffer(2),
      'image/webp',
    )
  }
  const res = await adapter.get('media/a.png')
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(await res.text()).toBe('png')
  expect(await adapter.stat('media/a.png')).toEqual({
    size: 3,
    contentType: 'image/png',
  })
  expect(await adapter.exists('media/none')).toBe(false)
  expect((await adapter.get('media/none')).status).toBe(404)
  expect(await adapter.list('media/a.png__transforms/')).toEqual([
    'media/a.png__transforms/1.webp',
    'media/a.png__transforms/2.webp',
    'media/a.png__transforms/3.webp',
  ])
  await adapter.delete('media/a.png')
  expect(await adapter.exists('media/a.png')).toBe(false)
})

test('R2 adapter presigns only when an S3 presigner is present', async () => {
  expect(new R2StorageAdapter(createFakeR2()).presignPut).toBeUndefined()
  const signed = new R2StorageAdapter(
    createFakeR2(),
    new S3StorageAdapter(s3Backend),
  )
  const url = new URL(
    await signed.presignPut!('media/a.jpg', { expiresIn: 60 }),
  )
  expect(url.pathname).toBe('/b/media/a.jpg')
})

test('workerStorageFactory uses the R2 binding and S3 keys for presign', () => {
  const factory = workerStorageFactory({ BUCKET_MEDIA: createFakeR2() })
  const local = factory(localBackend, bucket('media', localBackend))
  expect(local).toBeInstanceOf(R2StorageAdapter)
  expect(local.presignPut).toBeUndefined()
  expect(
    factory(s3Backend, bucket('media', s3Backend)).presignPut,
  ).toBeDefined()
})

test('workerStorageFactory falls back to S3 on fetch, and rejects local without R2', () => {
  const factory = workerStorageFactory({})
  expect(factory(s3Backend, bucket('docs', s3Backend))).toBeInstanceOf(
    S3StorageAdapter,
  )
  expect(() => factory(localBackend, bucket('docs', localBackend))).toThrow(
    'storage bucket "docs" needs the R2 binding BUCKET_DOCS',
  )
})
