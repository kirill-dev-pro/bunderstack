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
  await adapter.upload('test-file.txt', data, 'text/plain')
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
