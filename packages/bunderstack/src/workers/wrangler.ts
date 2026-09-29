// src/workers/wrangler.ts — wrangler.json rendered from the committed
// blueprint. The file is a local artifact (git-ignored): `celld dev`, a manual
// `wrangler deploy`, or `celld deploy` read it. Hosts render their own config
// from the same WorkerPlan.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { WorkerPlan } from '../worker-plan'

import { isBunderstackBackend } from '../backend'
import { parseWorkerBlueprintYaml } from '../blueprint'
import { workerPlanFromBlueprint } from '../worker-plan'

export type WranglerConfig = ReturnType<typeof toWranglerConfig>

export function toWranglerConfig(
  plan: WorkerPlan,
  names: { name: string; bucketName: (logical: string) => string },
) {
  return {
    name: names.name,
    main: plan.main,
    compatibility_date: plan.compatibilityDate,
    compatibility_flags: [...plan.compatibilityFlags],
    durable_objects: {
      bindings: plan.durableObjects.bindings.map((binding) => ({
        name: binding.name,
        class_name: binding.className,
      })),
    },
    migrations: plan.durableObjects.migrations.map((migration) => ({
      tag: migration.tag,
      new_sqlite_classes: [...migration.newSqliteClasses],
    })),
    r2_buckets: plan.buckets.map((bucket) => ({
      binding: bucket.binding,
      bucket_name: names.bucketName(bucket.name),
    })),
    assets: {
      directory: plan.assets.directory,
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: [...plan.assets.runWorkerFirst],
    },
    ...(plan.crons.length > 0 ? { triggers: { crons: [...plan.crons] } } : {}),
  }
}

/** A Worker name from package.json#name: no scope, lowercase, [a-z0-9-]. */
export function workerName(packageName: string | undefined): string {
  return (packageName ?? 'app')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
}

/**
 * Imports the app's backend. Entry precedence: the argument,
 * package.json#bunderstack.entry, src/bunderstack.ts.
 */
export async function loadBackend(directory: string, entry?: string) {
  const pkg = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8'),
  ) as { name?: string; bunderstack?: { entry?: string } }
  const path = entry ?? pkg.bunderstack?.entry ?? 'src/bunderstack.ts'
  const module = (await import(pathToFileURL(join(directory, path)).href)) as {
    backend?: unknown
  }
  if (!isBunderstackBackend(module.backend)) {
    throw new Error(`[bunderstack] ${path} must export backend`)
  }
  return { pkg, backend: module.backend }
}

export async function runWranglerCommand(options: {
  directory: string
  name?: string
  output?: string
}): Promise<{ path: string; changed: boolean }> {
  const directory = resolve(options.directory)
  const pkg = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8'),
  ) as { name?: string }
  let source: string
  try {
    source = await readFile(
      join(directory, 'bunderstack.blueprint.yaml'),
      'utf8',
    )
  } catch {
    throw new Error(
      '[bunderstack] bunderstack.blueprint.yaml does not exist; run `bunderstack blueprint`',
    )
  }
  const plan = workerPlanFromBlueprint(parseWorkerBlueprintYaml(source))
  const name = workerName(options.name ?? pkg.name)
  const config = toWranglerConfig(plan, {
    name,
    bucketName: (bucket) => `${name}-${bucket}`,
  })
  const path = join(directory, options.output ?? 'wrangler.json')
  const text = `${JSON.stringify(config, null, 2)}\n`
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  if (existing === text) return { path, changed: false }
  await writeFile(path, text)
  return { path, changed: true }
}
