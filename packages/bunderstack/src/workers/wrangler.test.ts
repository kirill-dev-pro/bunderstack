import { expect, test } from 'bun:test'

import type { BunderstackManifest } from '../manifest'

import { buildWranglerConfig } from './wrangler'

const sweep = {
  name: 'storage-sweep' as const,
  schedule: '0 4 * * *',
  timezone: 'UTC' as const,
}

function manifest(
  overrides: Partial<BunderstackManifest> = {},
): BunderstackManifest {
  return {
    version: 4,
    database: {
      dialect: 'sqlite',
      migrationsDirectory: './migrations',
      tables: [],
    },
    storage: {
      defaultBucket: 'media',
      buckets: [{ name: 'media', visibility: 'private' }],
    },
    realtime: { required: true },
    messaging: { channels: [] },
    environment: [],
    api: {
      operations: [
        {
          handle: 'hook',
          operationId: 'hook',
          effect: 'mutation',
          method: 'POST',
          path: '/webhooks/stripe',
        },
        { handle: 'rpcOnly', operationId: 'rpcOnly', effect: 'unknown' },
      ],
    },
    background: {
      jobs: [{ name: 'work' }],
      cron: [{ name: 'digest', schedule: '0 8 * * *', timezone: 'UTC' }],
      maintenance: [sweep],
    },
    ...overrides,
  }
}

test('the config has the DO bindings, R2 buckets, assets, and cron triggers', () => {
  const config = buildWranglerConfig(manifest(), {
    name: 'fikflix',
    compatibilityDate: '2026-09-28',
  })
  expect(config).toEqual({
    name: 'fikflix',
    main: 'src/worker.ts',
    compatibility_date: '2026-09-28',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: {
      bindings: [
        { name: 'SCHEDULER', class_name: 'Scheduler' },
        { name: 'REALTIME', class_name: 'RealtimeHub' },
        { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
      ],
    },
    migrations: [
      {
        tag: 'v1',
        new_sqlite_classes: ['Scheduler', 'RealtimeHub', 'RateLimiter'],
      },
    ],
    r2_buckets: [{ binding: 'BUCKET_MEDIA', bucket_name: 'fikflix-media' }],
    assets: {
      directory: 'dist/client',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*', '/webhooks/*'],
    },
    triggers: { crons: ['0 4 * * *', '0 8 * * *'] },
  })
})

test('no storage means no sweep trigger and no R2; many crons collapse', () => {
  const crons = Array.from({ length: 6 }, (_, i) => ({
    name: `c${i}`,
    schedule: `${i} * * * *`,
    timezone: 'UTC' as const,
  }))
  const config = buildWranglerConfig(
    manifest({
      storage: { defaultBucket: '', buckets: [] },
      background: { jobs: [], cron: crons, maintenance: [sweep] },
    }),
    { name: 'app', compatibilityDate: '2026-09-28' },
  )
  expect(config.r2_buckets).toEqual([])
  expect(config.triggers).toEqual({ crons: ['* * * * *'] })
})

test('no cron and no storage means no triggers key', () => {
  const config = buildWranglerConfig(
    manifest({
      storage: { defaultBucket: '', buckets: [] },
      background: { jobs: [], cron: [], maintenance: [sweep] },
    }),
    { name: 'app', compatibilityDate: '2026-09-28' },
  )
  expect('triggers' in config).toBe(false)
})
