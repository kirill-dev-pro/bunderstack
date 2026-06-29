// tests/storage/s3.test.ts
import { test, expect } from 'bun:test'

import { S3StorageAdapter } from '../../src/storage/s3'

const fakeAdapter = () =>
  new S3StorageAdapter({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-access-key-id',
    secretAccessKey: 'fake-secret-access-key',
    endpoint: 'https://s3.example.com',
  })

test('S3StorageAdapter constructor creates instance without throwing', () => {
  const adapter = fakeAdapter()
  expect(typeof adapter.upload).toBe('function')
  expect(typeof adapter.get).toBe('function')
  expect(typeof adapter.delete).toBe('function')
  expect(typeof adapter.exists).toBe('function')
})

test('S3StorageAdapter exposes presignPut, presignGet, stat, publicUrlFor', () => {
  const adapter = fakeAdapter()
  expect(typeof adapter.presignPut).toBe('function')
  expect(typeof adapter.presignGet).toBe('function')
  expect(typeof adapter.stat).toBe('function')
  expect(typeof adapter.publicUrlFor).toBe('function')
})

test('presignPut returns a non-empty string containing the key (offline, no network)', async () => {
  const adapter = fakeAdapter()
  const url = await adapter.presignPut!('uploads/avatar.jpg', {
    expiresIn: 3600,
    contentType: 'image/jpeg',
  })
  expect(typeof url).toBe('string')
  expect(url.length).toBeGreaterThan(0)
  expect(url).toContain('avatar.jpg')
})

test('presignGet returns a non-empty string containing the key (offline, no network)', async () => {
  const adapter = fakeAdapter()
  const url = await adapter.presignGet!('uploads/avatar.jpg', {
    expiresIn: 3600,
  })
  expect(typeof url).toBe('string')
  expect(url.length).toBeGreaterThan(0)
  expect(url).toContain('avatar.jpg')
})

test('presignPut and presignGet return different URLs (method differs)', async () => {
  const adapter = fakeAdapter()
  const putUrl = await adapter.presignPut!('myfile.txt', { expiresIn: 3600 })
  const getUrl = await adapter.presignGet!('myfile.txt', { expiresIn: 3600 })
  expect(putUrl).not.toBe(getUrl)
})

test('presignPut URL contains a signature query param (X-Amz-Signature)', async () => {
  const adapter = fakeAdapter()
  const url = await adapter.presignPut!('uploads/doc.pdf', {
    expiresIn: 600,
    contentType: 'application/pdf',
  })
  expect(url).toMatch(/X-Amz-Signature|X-Amz-Expires/i)
})

test('presignGet URL contains a signature query param (X-Amz-Signature)', async () => {
  const adapter = fakeAdapter()
  const url = await adapter.presignGet!('uploads/doc.pdf', { expiresIn: 600 })
  expect(url).toMatch(/X-Amz-Signature|X-Amz-Expires/i)
})

test('publicUrlFor with publicUrl trims trailing slash and builds URL', () => {
  const adapter = new S3StorageAdapter({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-key',
    secretAccessKey: 'fake-secret',
    publicUrl: 'https://cdn.x/',
  })
  expect(adapter.publicUrlFor!('avatars/a.jpg')).toBe(
    'https://cdn.x/avatars/a.jpg',
  )
})

test('publicUrlFor without publicUrl returns undefined', () => {
  const adapter = fakeAdapter()
  expect(adapter.publicUrlFor!('avatars/a.jpg')).toBeUndefined()
})

test('publicUrlFor without trailing slash works correctly', () => {
  const adapter = new S3StorageAdapter({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'fake-key',
    secretAccessKey: 'fake-secret',
    publicUrl: 'https://cdn.x',
  })
  expect(adapter.publicUrlFor!('avatars/a.jpg')).toBe(
    'https://cdn.x/avatars/a.jpg',
  )
})
