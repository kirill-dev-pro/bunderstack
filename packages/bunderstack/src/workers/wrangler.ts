// src/workers/wrangler.ts — wrangler.json from the backend manifest. The same
// file deploys with `wrangler deploy` (Cloudflare) and `celld deploy`.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { BunderstackManifest } from '../manifest'

import { isBunderstackBackend } from '../backend'
import { bucketBindingName } from './r2'

/** Cloudflare's per-Worker Cron Trigger limit on the free plan. */
const MAX_CRONS = 5

export type WranglerConfig = ReturnType<typeof buildWranglerConfig>

export function buildWranglerConfig(
  manifest: BunderstackManifest,
  options: {
    name: string
    compatibilityDate: string
    main?: string
    assetsDirectory?: string
  },
) {
  const hasStorage = manifest.storage.buckets.length > 0
  const crons = [
    ...new Set([
      ...manifest.background.cron.map((cron) => cron.schedule),
      ...(hasStorage
        ? manifest.background.maintenance.map((task) => task.schedule)
        : []),
    ]),
  ].sort()
  // Operations without their own path are served through /api/rpc.
  const prefixes = [
    ...new Set([
      '/api/*',
      ...manifest.api.operations
        .filter((op) => op.path)
        .map((op) => `/${op.path!.split('/')[1]}/*`),
    ]),
  ]
  return {
    name: options.name,
    main: options.main ?? 'src/worker.ts',
    compatibility_date: options.compatibilityDate,
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
    r2_buckets: manifest.storage.buckets.map((bucket) => ({
      binding: bucketBindingName(bucket.name),
      bucket_name: `${options.name}-${bucket.name}`,
    })),
    assets: {
      directory: options.assetsDirectory ?? 'dist/client',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: prefixes,
    },
    ...(crons.length > 0
      ? {
          triggers: {
            crons: crons.length > MAX_CRONS ? ['* * * * *'] : crons,
          },
        }
      : {}),
  }
}

export class WranglerCheckError extends Error {
  constructor(path: string) {
    super(`[bunderstack] ${path} is out of date; run \`bunderstack wrangler\``)
    this.name = 'WranglerCheckError'
  }
}

export async function runWranglerCommand(options: {
  directory: string
  entry?: string
  name?: string
  assets?: string
  output?: string
  check?: boolean
}): Promise<{ path: string; changed: boolean }> {
  const directory = resolve(options.directory)
  const pkg = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8'),
  ) as { name?: string; bunderstack?: { entry?: string } }
  const entry = options.entry ?? pkg.bunderstack?.entry ?? 'src/bunderstack.ts'
  const module = (await import(pathToFileURL(join(directory, entry)).href)) as {
    backend?: unknown
  }
  if (!isBunderstackBackend(module.backend)) {
    throw new Error(`[bunderstack] ${entry} must export backend`)
  }
  const path = join(directory, options.output ?? 'wrangler.json')
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  const previous = existing
    ? (JSON.parse(existing) as { compatibility_date?: string })
    : undefined
  const name = (options.name ?? pkg.name ?? 'app')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
  const config = buildWranglerConfig(
    module.backend.inspect({ env: process.env }),
    {
      name,
      // Keep the date once chosen, so --check stays stable across days.
      compatibilityDate:
        previous?.compatibility_date ?? new Date().toISOString().slice(0, 10),
      assetsDirectory: options.assets,
    },
  )
  const text = `${JSON.stringify(config, null, 2)}\n`
  if (options.check) {
    if (existing !== text) throw new WranglerCheckError(path)
    return { path, changed: false }
  }
  if (existing === text) return { path, changed: false }
  await writeFile(path, text)
  return { path, changed: true }
}
