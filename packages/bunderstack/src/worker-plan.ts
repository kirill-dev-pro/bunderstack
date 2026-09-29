// src/worker-plan.ts — what a Worker app needs from its host, derived only
// from the committed version 2 blueprint. Physical names (script, buckets) are
// the renderer's job: `wrangler.json` locally, a host's own config in hosting.
import type { WorkerBlueprint } from './blueprint'

/** Cloudflare's per-Worker Cron Trigger limit on the free plan. */
const MAX_CRONS = 5

export type WorkerPlan = {
  main: string
  compatibilityDate: string
  compatibilityFlags: string[]
  durableObjects: {
    bindings: { name: string; className: string }[]
    migrations: { tag: string; newSqliteClasses: string[] }[]
  }
  buckets: { name: string; binding: string }[]
  crons: string[]
  assets: { directory: string; runWorkerFirst: string[] }
}

export function bucketBindingName(bucketName: string): string {
  return `BUCKET_${bucketName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export function workerPlanFromBlueprint(
  blueprint: WorkerBlueprint,
): WorkerPlan {
  const { worker } = blueprint.application
  const buckets = blueprint.resources.storage.buckets
  const crons = [
    ...new Set([
      ...blueprint.background.cron.map((cron) => cron.schedule),
      ...(buckets.length > 0
        ? blueprint.background.maintenance.map((task) => task.schedule)
        : []),
    ]),
  ].sort()
  // Operations without their own path are served through /api/rpc.
  const runWorkerFirst = [
    ...new Set([
      '/api/*',
      ...(blueprint.api?.operations ?? [])
        .filter((op) => op.path)
        .map((op) => `/${op.path!.split('/')[1]}/*`),
    ]),
  ]
  return {
    main: worker.main,
    compatibilityDate: worker.compatibilityDate,
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
    buckets: buckets.map((bucket) => ({
      name: bucket.name,
      binding: bucketBindingName(bucket.name),
    })),
    crons: crons.length > MAX_CRONS ? ['* * * * *'] : crons,
    assets: { directory: worker.assets, runWorkerFirst },
  }
}
