// tests/storage/s3.test.ts
import { test, expect } from 'bun:test'

import { S3StorageAdapter } from '../../src/storage/s3'

test('S3StorageAdapter constructor creates instance without throwing', () => {
  const adapter = new S3StorageAdapter({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-key',
    secretAccessKey: 'fake-secret',
  })
  expect(typeof adapter.upload).toBe('function')
  expect(typeof adapter.get).toBe('function')
  expect(typeof adapter.delete).toBe('function')
  expect(typeof adapter.exists).toBe('function')
})
