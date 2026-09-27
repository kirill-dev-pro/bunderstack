import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { ResolvedBackend } from './storage/buckets'
import type { StorageAdapter } from './storage/index'

import { libsql } from './database/libsql'
import { bunderstack } from './index'
import { createMemoryRateLimitStore, resolvePlatform } from './platform'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

class MemoryAdapter implements StorageAdapter {
  readonly objects = new Map<string, Uint8Array>()
  async upload(key: string, data: Blob | ArrayBuffer) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    this.objects.set(key, new Uint8Array(bytes))
  }
  async get(key: string) {
    const value = this.objects.get(key)
    return value
      ? new Response(value as unknown as BodyInit)
      : new Response('Not found', { status: 404 })
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  async exists(key: string) {
    return this.objects.has(key)
  }
}

test('resolvePlatform fills every missing service with an in-memory default', async () => {
  const platform = resolvePlatform()
  expect(platform.realtime).toBeUndefined()
  expect(await platform.jobs.notify(1)).toBeUndefined()
  expect(typeof platform.storage).toBe('function')
  expect((await platform.rateLimit.hit('k', 1000, 1, 0)).allowed).toBe(true)
})

test('resolvePlatform keeps the services that the caller gives', () => {
  const notify = () => {}
  const platform = resolvePlatform({ jobs: { notify } })
  expect(platform.jobs.notify).toBe(notify)
})

test('memory rate limit store allows max hits per window, then resets', async () => {
  const store = createMemoryRateLimitStore()
  expect(await store.hit('a', 1000, 2, 0)).toEqual({
    allowed: true,
    resetAt: 1000,
  })
  expect(await store.hit('a', 1000, 2, 10)).toEqual({
    allowed: true,
    resetAt: 1000,
  })
  expect(await store.hit('a', 1000, 2, 20)).toEqual({
    allowed: false,
    resetAt: 1000,
  })
  expect(await store.hit('a', 1000, 2, 1000)).toEqual({
    allowed: true,
    resetAt: 2000,
  })
  expect((await store.hit('b', 1000, 2, 20)).allowed).toBe(true)
})

test('start uses the platform storage factory for every bucket', async () => {
  const seen: ResolvedBackend[] = []
  const names: string[] = []
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    storage: {
      local: true,
      defaultBucket: 'media',
      buckets: { media: {}, docs: {} },
    },
  }).start({
    env: { DATABASE_URL: ':memory:' },
    platform: {
      storage: (backend, bucket) => {
        seen.push(backend)
        names.push(bucket.name)
        return new MemoryAdapter()
      },
    },
  })
  try {
    expect(seen.length).toBe(2)
    expect(seen.every((backend) => backend.type === 'local')).toBe(true)
    expect(names.sort()).toEqual(['docs', 'media'])
  } finally {
    await app.close()
  }
})
