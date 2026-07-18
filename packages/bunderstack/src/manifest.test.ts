import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { buildManifest } from './manifest'
import { resolveBuckets } from './storage/buckets'

const posts = sqliteTable('app_posts', {
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
  expect(manifest.version).toBe(2)
  expect(manifest.tableMap).toEqual({ posts: 'app_posts' })
  expect(manifest.systemTables).toEqual({
    jobs: '_bunderstack_jobs',
    files: 'bunderstack_file_meta',
    scheduledRuns: '_bunderstack_cron_runs',
  })
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
  expect(manifest.background).toEqual({
    jobs: [],
    cron: [],
    maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *' }],
  })
})

test('manifest separates queue jobs from cron schedules', () => {
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    realtime: false,
    jobs: {
      generateLook: { kind: 'job', handler: async () => {} },
      nightly: {
        kind: 'cron',
        schedule: '0 3 * * *',
        handler: async () => {},
      },
    },
  })
  expect(manifest.background).toEqual({
    jobs: [{ name: 'generateLook' }],
    cron: [{ name: 'nightly', schedule: '0 3 * * *', timezone: 'UTC' }],
    maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *' }],
  })
})

test('manifest background is empty except maintenance when no jobs are configured', () => {
  const manifest = buildManifest({
    schema,
    dialect: 'sqlite',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    realtime: false,
    jobs: undefined,
  })
  expect(manifest.background.jobs).toEqual([])
  expect(manifest.background.cron).toEqual([])
})
