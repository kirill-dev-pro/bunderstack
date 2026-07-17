import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { buildManifest } from './manifest'
import { resolveBuckets } from './storage/buckets'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
})
const schema = { posts }

test('buildManifest describes tables, buckets, env requirements', () => {
  const storage = resolveBuckets(
    {
      local: './uploads',
      defaultBucket: 'attachments',
      buckets: {
        avatars: { visibility: 'public' },
        attachments: {},
      },
    },
    {},
  )
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage,
    envConfig: {
      server: { STRIPE_KEY: z.string(), LOG_LEVEL: z.string().optional() },
      client: { PUBLIC_APP_NAME: z.string() },
    },
    realtime: true,
    jobs: undefined,
  })

  expect(manifest.dialect).toBe('sqlite')
  expect(manifest.tables).toEqual(['posts'])
  expect(manifest.defaultBucket).toBe('attachments')
  expect(manifest.buckets).toEqual([
    { name: 'avatars', visibility: 'public' },
    { name: 'attachments', visibility: 'private' },
  ])
  expect(manifest.realtime).toBe(true)
  expect(manifest.env.server).toEqual([
    { key: 'STRIPE_KEY', required: true },
    { key: 'LOG_LEVEL', required: false },
  ])
  expect(manifest.env.client).toEqual([
    { key: 'PUBLIC_APP_NAME', required: true },
  ])
})

test('buildManifest handles the zero-config app', () => {
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    realtime: false,
    jobs: undefined,
  })
  expect(manifest.buckets).toEqual([{ name: 'default', visibility: 'private' }])
  expect(manifest.env).toEqual({ server: [], client: [] })
  expect(manifest.jobs).toEqual([])
})

test('manifest lists declared jobs with their cron schedules', () => {
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    realtime: false,
    jobs: {
      generateLook: { handler: async () => {} },
      nightly: { cron: '0 3 * * *', handler: async () => {} },
    },
  })
  expect(manifest.jobs).toEqual([
    { name: 'generateLook' },
    { name: 'nightly', cron: '0 3 * * *' },
  ])
})

test('manifest jobs is empty when no jobs are configured', () => {
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    realtime: false,
    jobs: undefined,
  })
  expect(manifest.jobs).toEqual([])
})
