import { expect, test } from 'bun:test'

import type { WorkerBlueprint } from './blueprint'

import { workerPlanFromBlueprint } from './worker-plan'

const sweep = {
  name: 'storage-sweep' as const,
  schedule: '0 4 * * *',
  timezone: 'UTC' as const,
}

function blueprint(
  overrides: {
    buckets?: WorkerBlueprint['resources']['storage']['buckets']
    background?: WorkerBlueprint['background']
  } = {},
): WorkerBlueprint {
  return {
    version: 2,
    generator: { name: 'bunderstack', version: '1.0.0-beta.3' },
    application: {
      framework: 'solid',
      scripts: { build: 'build' },
      worker: {
        main: 'src/worker.ts',
        compatibilityDate: '2026-09-28',
        assets: 'dist/client',
      },
    },
    bunderstack: { entry: 'src/bunderstack.ts', manifestVersion: 4 },
    resources: {
      database: {
        dialect: 'sqlite',
        migrationsDirectory: 'migrations',
        migrationMode: 'push',
        tables: [],
      },
      storage: {
        defaultBucket: 'media',
        buckets: overrides.buckets ?? [
          { name: 'media', visibility: 'private' },
          { name: 'public-files', visibility: 'public' },
        ],
      },
      messaging: { channels: [] },
    },
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
    background: overrides.background ?? {
      jobs: [{ name: 'work' }],
      cron: [{ name: 'digest', schedule: '0 8 * * *', timezone: 'UTC' }],
      maintenance: [sweep],
    },
  }
}

test('the plan carries the Worker settings, DOs, buckets, routes, and crons', () => {
  expect(workerPlanFromBlueprint(blueprint())).toEqual({
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
    buckets: [
      { name: 'media', binding: 'BUCKET_MEDIA' },
      { name: 'public-files', binding: 'BUCKET_PUBLIC_FILES' },
    ],
    crons: ['0 4 * * *', '0 8 * * *'],
    assets: {
      directory: 'dist/client',
      runWorkerFirst: ['/api/*', '/webhooks/*'],
    },
  })
})

test('no buckets: no sweep cron; more than five crons collapse', () => {
  const cron = Array.from({ length: 6 }, (_, i) => ({
    name: `c${i}`,
    schedule: `${i} * * * *`,
    timezone: 'UTC' as const,
  }))
  const plan = workerPlanFromBlueprint(
    blueprint({
      buckets: [],
      background: { jobs: [], cron, maintenance: [sweep] },
    }),
  )
  expect(plan.buckets).toEqual([])
  expect(plan.crons).toEqual(['* * * * *'])
})

test('no cron and no buckets means no crons', () => {
  const plan = workerPlanFromBlueprint(
    blueprint({
      buckets: [],
      background: { jobs: [], cron: [], maintenance: [sweep] },
    }),
  )
  expect(plan.crons).toEqual([])
})

test('a blueprint without api operations routes only /api through the Worker', () => {
  const { api: _api, ...withoutApi } = blueprint()
  expect(workerPlanFromBlueprint(withoutApi).assets.runWorkerFirst).toEqual([
    '/api/*',
  ])
})

test('the plan is a fresh object each time', () => {
  const source = blueprint()
  const plan = workerPlanFromBlueprint(source)
  plan.crons.push('mutated')
  expect(workerPlanFromBlueprint(source).crons).not.toContain('mutated')
})
