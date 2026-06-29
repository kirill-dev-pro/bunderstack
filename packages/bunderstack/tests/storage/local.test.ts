// tests/storage/local.test.ts
import { test, expect, afterAll } from 'bun:test'
import { rmSync } from 'node:fs'

import { LocalStorageAdapter } from '../../src/storage/local'

const basePath = './.test-uploads'

afterAll(() => {
  rmSync(basePath, { recursive: true, force: true })
})

test('upload writes file and exists returns true', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const data = new TextEncoder().encode('hello storage')
  await adapter.upload('test-file.txt', data.buffer, 'text/plain')
  expect(await adapter.exists('test-file.txt')).toBe(true)
})

test('get returns a 200 Response with correct body', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const res = await adapter.get('test-file.txt')
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toBe('hello storage')
})

test('delete removes file and exists returns false', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  await adapter.delete('test-file.txt')
  expect(await adapter.exists('test-file.txt')).toBe(false)
})

test('get returns 404 for missing file', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const res = await adapter.get('does-not-exist.txt')
  expect(res.status).toBe(404)
})

test('stat returns size and contentType after upload', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const content = 'stat test content'
  const data = new TextEncoder().encode(content)
  await adapter.upload('stat-file.txt', data.buffer, 'text/plain')
  const info = await adapter.stat!('stat-file.txt')
  expect(info).not.toBeNull()
  expect(info!.size).toBe(data.byteLength)
  expect(typeof info!.contentType).toBe('string')
})

test('stat returns null for missing file', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const info = await adapter.stat!('does-not-exist.txt')
  expect(info).toBeNull()
})

test('list returns derivative keys under a prefix; missing prefix → []', async () => {
  const adapter = new LocalStorageAdapter(basePath)
  const fileId = 'files/abc.png'
  const bytes = new TextEncoder().encode('x')
  await adapter.upload(fileId, bytes.buffer, 'image/png')
  await adapter.upload(
    `${fileId}__transforms/h1.webp`,
    bytes.buffer,
    'image/webp',
  )
  await adapter.upload(
    `${fileId}__transforms/h2.webp`,
    bytes.buffer,
    'image/webp',
  )

  const keys = await adapter.list!(`${fileId}__transforms/`)
  expect(keys.sort()).toEqual([
    `${fileId}__transforms/h1.webp`,
    `${fileId}__transforms/h2.webp`,
  ])

  expect(await adapter.list!('files/nope__transforms/')).toEqual([])
})

test('LocalStorageAdapter does not expose presignPut', () => {
  const adapter = new LocalStorageAdapter(basePath)
  expect(
    (adapter as unknown as Record<string, unknown>)['presignPut'],
  ).toBeUndefined()
})

test('LocalStorageAdapter does not expose presignGet', () => {
  const adapter = new LocalStorageAdapter(basePath)
  expect(
    (adapter as unknown as Record<string, unknown>)['presignGet'],
  ).toBeUndefined()
})

test('LocalStorageAdapter does not expose publicUrlFor', () => {
  const adapter = new LocalStorageAdapter(basePath)
  expect(
    (adapter as unknown as Record<string, unknown>)['publicUrlFor'],
  ).toBeUndefined()
})
