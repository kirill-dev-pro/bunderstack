// src/worker-plan.ts — what a Worker app needs from its host, derived only
// from the committed version 2 blueprint. Physical names (script, buckets) are
// the renderer's job: `wrangler.json` locally, a host's own config in hosting.
import type { WorkerBlueprint, WorkerRender } from './blueprint'

/** Cloudflare's per-Worker Cron Trigger limit on the free plan. */
const MAX_CRONS = 5

export type WorkerPlan = {
  render: WorkerRender
  /** The source entry for the Vite plugin and wrangler. */
  main: string
  compatibilityDate: string
  compatibilityFlags: string[]
  durableObjects: {
    bindings: { name: string; className: string }[]
    migrations: { tag: string; newSqliteClasses: string[] }[]
  }
  buckets: { name: string; binding: string }[]
  crons: string[]
  assets: {
    directory: string
    notFoundHandling: 'none' | 'single-page-application'
    runWorkerFirst: string[]
  }
  /** What a host deploys after `bun run build`, in both render modes. */
  artifact: { main: 'dist/server/index.js'; assets: string; modules: true }
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
  const ssr = worker.render === 'ssr'
  return {
    render: worker.render,
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
    assets: {
      directory: worker.assets,
      notFoundHandling: ssr ? 'none' : 'single-page-application',
      // SSR: a path without a file already reaches the Worker.
      runWorkerFirst: ssr ? [] : runWorkerFirst,
    },
    artifact: {
      main: 'dist/server/index.js',
      assets: worker.assets,
      modules: true,
    },
  }
}
