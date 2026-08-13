import { test, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { bunderstackJobs } from './internal-tables'
import { buildManifest, parseManifest } from './manifest'
import { resolveBuckets } from './storage/buckets'

const posts = sqliteTable('app_posts', { id: text('id').primaryKey() })
const accounts = sqliteTable('app_accounts', { id: text('id').primaryKey() })
const schema = { posts, accounts }

function makeManifest() {
  return buildManifest({
    schema,
    dialect: 'sqlite',
    migrationsDirectory: './migrations',
    storage: resolveBuckets(
      {
        local: './uploads',
        defaultBucket: 'attachments',
        buckets: {
          avatars: { visibility: 'public' },
          attachments: {},
        },
      },
      {},
    ),
    envConfig: {
      server: {
        STRIPE_KEY: v.string(),
        LOG_LEVEL: v.optional(v.string()),
      },
      client: { PUBLIC_APP_NAME: v.string() },
    },
    emailProvider: 'resend',
    realtime: true,
    jobs: {
      generateLook: { kind: 'job', handler: async () => {} },
      nightly: {
        kind: 'cron',
        schedule: '0 3 * * *',
        handler: async () => {},
      },
    },
  })
}

test('buildManifest describes deployment requirements deterministically', () => {
  expect(makeManifest()).toEqual({
    version: 3,
    database: {
      dialect: 'sqlite',
      migrationsDirectory: './migrations',
      tables: [
        {
          exportName: '_system.emailEvents',
          physicalName: '_bunderstack_email_events',
          system: true,
        },
        {
          exportName: '_system.emails',
          physicalName: '_bunderstack_emails',
          system: true,
        },
        {
          exportName: '_system.idempotency',
          physicalName: '_bunderstack_idempotency',
          system: true,
        },
        {
          exportName: '_system.jobs',
          physicalName: '_bunderstack_jobs',
          system: true,
        },
        { exportName: 'accounts', physicalName: 'app_accounts', system: false },
        { exportName: 'posts', physicalName: 'app_posts', system: false },
        {
          exportName: '_system.files',
          physicalName: 'bunderstack_file_meta',
          system: true,
        },
      ],
    },
    storage: {
      defaultBucket: 'attachments',
      buckets: [
        { name: 'attachments', visibility: 'private' },
        { name: 'avatars', visibility: 'public' },
      ],
    },
    realtime: { required: true },
    environment: [
      { key: 'LOG_LEVEL', required: false, scope: 'server' },
      { key: 'PUBLIC_APP_NAME', required: true, scope: 'client' },
      { key: 'RESEND_API_KEY', required: true, scope: 'server' },
      { key: 'STRIPE_KEY', required: true, scope: 'server' },
    ],
    background: {
      jobs: [{ name: 'generateLook' }],
      cron: [{ name: 'nightly', schedule: '0 3 * * *', timezone: 'UTC' }],
      maintenance: [
        { name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' },
      ],
    },
  })
})

test('parseManifest rejects unsupported versions and invalid declarations', () => {
  const manifest = makeManifest()
  expect(parseManifest(manifest)).toEqual(manifest)
  expect(() => parseManifest({ ...manifest, version: 2 })).toThrow(/version/)
  expect(() =>
    parseManifest({
      ...manifest,
      database: { ...manifest.database, migrationsDirectory: '../migrations' },
    }),
  ).toThrow(/migrationsDirectory/)
  expect(() =>
    parseManifest({
      ...manifest,
      environment: [...manifest.environment, manifest.environment[0]!],
    }),
  ).toThrow(/duplicate environment key/)
})

test('buildManifest handles zero-config apps', () => {
  const manifest = buildManifest({
    schema: { posts },
    dialect: 'sqlite',
    migrationsDirectory: './migrations',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    emailProvider: undefined,
    realtime: false,
    jobs: undefined,
  })
  expect(manifest.storage).toEqual({
    defaultBucket: 'default',
    buckets: [{ name: 'default', visibility: 'private' }],
  })
  expect(manifest.environment).toEqual([])
  expect(manifest.background).toEqual({
    jobs: [],
    cron: [],
    maintenance: [
      { name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' },
    ],
  })
})

test('buildManifest does not duplicate system tables re-exported by an app schema', () => {
  const manifest = buildManifest({
    schema: { posts, bunderstackJobs },
    dialect: 'sqlite',
    migrationsDirectory: './migrations',
    storage: resolveBuckets(undefined, {}),
    envConfig: undefined,
    emailProvider: undefined,
    realtime: false,
    jobs: undefined,
  })
  expect(
    manifest.database.tables.filter(
      (table) => table.physicalName === '_bunderstack_jobs',
    ),
  ).toHaveLength(1)
})
