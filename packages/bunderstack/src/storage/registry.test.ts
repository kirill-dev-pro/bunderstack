// tests/storage/registry.test.ts
import { test, expect } from 'bun:test'

import { resolveBuckets } from './buckets'
import { LocalStorageAdapter } from './local'
import {
  createAdapter,
  createBucketStorages,
} from './registry'
import { S3StorageAdapter } from './s3'

const fakeEnv = {
  S3_ACCESS_KEY_ID: 'fake-key',
  S3_SECRET_ACCESS_KEY: 'fake-secret',
  S3_REGION: 'us-east-1',
}

// ---------------------------------------------------------------------------
// createAdapter
// ---------------------------------------------------------------------------

test('createAdapter local backend returns LocalStorageAdapter', () => {
  const adapter = createAdapter({ type: 'local', path: '/tmp/test-storage' })
  expect(adapter).toBeInstanceOf(LocalStorageAdapter)
})

test('createAdapter s3 backend returns S3StorageAdapter', () => {
  const adapter = createAdapter({
    type: 's3',
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-key',
    secretAccessKey: 'fake-secret',
  })
  expect(adapter).toBeInstanceOf(S3StorageAdapter)
})

test('createAdapter s3 with endpoint returns S3StorageAdapter', () => {
  const adapter = createAdapter({
    type: 's3',
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-key',
    secretAccessKey: 'fake-secret',
    endpoint: 'https://s3.example.com',
  })
  expect(adapter).toBeInstanceOf(S3StorageAdapter)
})

// ---------------------------------------------------------------------------
// createBucketStorages
// ---------------------------------------------------------------------------

test('createBucketStorages builds registry with correct keys', () => {
  const resolved = resolveBuckets(
    {
      defaultBucket: 'avatars',
      buckets: {
        avatars: { local: '/tmp/avatars' },
        documents: {
          s3: { bucket: 'docs-bucket', region: 'us-east-1' },
        },
      },
    },
    fakeEnv,
  )
  const registry = createBucketStorages(resolved)
  expect(registry.size).toBe(2)
  expect(registry.has('avatars')).toBe(true)
  expect(registry.has('documents')).toBe(true)
})

test('createBucketStorages local bucket has LocalStorageAdapter', () => {
  const resolved = resolveBuckets(
    {
      defaultBucket: 'avatars',
      buckets: {
        avatars: { local: '/tmp/avatars' },
        documents: {
          s3: { bucket: 'docs-bucket' },
        },
      },
    },
    fakeEnv,
  )
  const registry = createBucketStorages(resolved)
  const avatarsStorage = registry.get('avatars')!
  expect(avatarsStorage).toBeDefined()
  expect(avatarsStorage.adapter).toBeInstanceOf(LocalStorageAdapter)
})

test('createBucketStorages s3 bucket has S3StorageAdapter', () => {
  const resolved = resolveBuckets(
    {
      defaultBucket: 'avatars',
      buckets: {
        avatars: { local: '/tmp/avatars' },
        documents: {
          s3: { bucket: 'docs-bucket' },
        },
      },
    },
    fakeEnv,
  )
  const registry = createBucketStorages(resolved)
  const docsStorage = registry.get('documents')!
  expect(docsStorage).toBeDefined()
  expect(docsStorage.adapter).toBeInstanceOf(S3StorageAdapter)
})

test('createBucketStorages each BucketStorage.bucket matches resolved bucket', () => {
  const resolved = resolveBuckets(
    {
      defaultBucket: 'avatars',
      buckets: {
        avatars: { local: '/tmp/avatars' },
        documents: {
          s3: { bucket: 'docs-bucket' },
        },
      },
    },
    fakeEnv,
  )
  const registry = createBucketStorages(resolved)
  const avatarsBucket = registry.get('avatars')!.bucket
  const docsBucket = registry.get('documents')!.bucket
  expect(avatarsBucket).toBe(resolved.buckets.get('avatars')!)
  expect(docsBucket).toBe(resolved.buckets.get('documents')!)
})

test('createBucketStorages s3 adapter exposes presignPut as function', () => {
  const resolved = resolveBuckets(
    {
      defaultBucket: 'avatars',
      buckets: {
        avatars: { local: '/tmp/avatars' },
        documents: {
          s3: { bucket: 'docs-bucket' },
        },
      },
    },
    fakeEnv,
  )
  const registry = createBucketStorages(resolved)
  const docsAdapter = registry.get('documents')!.adapter
  expect(typeof docsAdapter.presignPut).toBe('function')
})

test('createBucketStorages local adapter does not expose presignPut', () => {
  const resolved = resolveBuckets(
    {
      defaultBucket: 'avatars',
      buckets: {
        avatars: { local: '/tmp/avatars' },
        documents: {
          s3: { bucket: 'docs-bucket' },
        },
      },
    },
    fakeEnv,
  )
  const registry = createBucketStorages(resolved)
  const avatarsAdapter = registry.get('avatars')!.adapter
  expect(avatarsAdapter.presignPut).toBeUndefined()
})
