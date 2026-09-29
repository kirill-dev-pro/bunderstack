import { expect, test } from 'bun:test'

import type { WorkerPlan } from '../worker-plan'

import { toWranglerConfig } from './wrangler'

const plan: WorkerPlan = {
  main: 'src/worker.ts',
  compatibilityDate: '2026-09-28',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    bindings: [
      { name: 'SCHEDULER', className: 'Scheduler' },
      { name: 'REALTIME', className: 'RealtimeHub' },
      { name: 'RATE_LIMITER', className: 'RateLimiter' },
    ],
    migrations: [
      {
        tag: 'v1',
        newSqliteClasses: ['Scheduler', 'RealtimeHub', 'RateLimiter'],
      },
    ],
  },
  buckets: [{ name: 'media', binding: 'BUCKET_MEDIA' }],
  crons: ['0 4 * * *', '0 8 * * *'],
  assets: {
    directory: 'dist/client',
    runWorkerFirst: ['/api/*', '/webhooks/*'],
  },
}

test('wrangler.json is the plan with local physical names', () => {
  expect(
    toWranglerConfig(plan, {
      name: 'fikflix',
      bucketName: (bucket) => `fikflix-${bucket}`,
    }),
  ).toEqual({
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

test('no crons means no triggers key', () => {
  const config = toWranglerConfig(
    { ...plan, crons: [] },
    { name: 'app', bucketName: (bucket) => bucket },
  )
  expect('triggers' in config).toBe(false)
})
