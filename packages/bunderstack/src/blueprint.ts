import { parse, stringify } from 'yaml'
import { z } from 'zod'

import type { BunderstackManifest } from './manifest'

import { parseCron } from './jobs/cron'

export type MigrationMode = 'migrations' | 'push'

export type BunderstackBlueprint = {
  version: 1
  generator: { name: 'bunderstack'; version: string }
  application: {
    framework: 'tanstack-start'
    scripts: { build: 'build'; start: 'start'; worker?: 'worker' }
  }
  bunderstack: { entry: string; manifestVersion: 3 }
  resources: {
    database: BunderstackManifest['database'] & { migrationMode: MigrationMode }
    storage: BunderstackManifest['storage']
    realtime?: { required: true }
  }
  environment: BunderstackManifest['environment']
  background: BunderstackManifest['background'] & {
    worker: { required: boolean }
  }
}

const nonEmpty = z.string().min(1)
const relativePath = nonEmpty.refine(
  (value) =>
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '..'),
  { message: 'entry must be a relative path without traversal' },
)
const cronSchedule = nonEmpty.refine(
  (value) => {
    try {
      parseCron(value)
      return true
    } catch {
      return false
    }
  },
  { message: 'invalid cron schedule' },
)

const blueprintSchema = z
  .object({
    version: z.literal(1),
    generator: z
      .object({ name: z.literal('bunderstack'), version: nonEmpty })
      .strict(),
    application: z
      .object({
        framework: z.literal('tanstack-start'),
        scripts: z
          .object({
            build: z.literal('build'),
            start: z.literal('start'),
            worker: z.literal('worker').optional(),
          })
          .strict(),
      })
      .strict(),
    bunderstack: z
      .object({ entry: relativePath, manifestVersion: z.literal(3) })
      .strict(),
    resources: z
      .object({
        database: z
          .object({
            dialect: z.enum(['sqlite', 'pg']),
            migrationsDirectory: relativePath,
            migrationMode: z.enum(['migrations', 'push']),
            tables: z.array(
              z
                .object({
                  exportName: nonEmpty,
                  physicalName: nonEmpty,
                  system: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
        storage: z
          .object({
            defaultBucket: nonEmpty,
            buckets: z.array(
              z
                .object({
                  name: nonEmpty,
                  visibility: z.enum(['public', 'private']),
                })
                .strict(),
            ),
          })
          .strict(),
        realtime: z
          .object({ required: z.literal(true) })
          .strict()
          .optional(),
      })
      .strict(),
    environment: z.array(
      z
        .object({
          key: nonEmpty,
          required: z.boolean(),
          scope: z.enum(['server', 'client']),
        })
        .strict(),
    ),
    background: z
      .object({
        worker: z.object({ required: z.boolean() }).strict(),
        jobs: z.array(z.object({ name: nonEmpty }).strict()),
        cron: z.array(
          z
            .object({
              name: nonEmpty,
              schedule: cronSchedule,
              timezone: z.literal('UTC'),
            })
            .strict(),
        ),
        maintenance: z.array(
          z
            .object({
              name: z.literal('storage-sweep'),
              schedule: cronSchedule,
              timezone: z.literal('UTC'),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()

function sortBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  return [...entries].sort((left, right) => key(left).localeCompare(key(right)))
}

function rejectDuplicates(collection: string, values: readonly string[]): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value))
      throw new Error(`[bunderstack] duplicate ${collection} "${value}"`)
    seen.add(value)
  }
}

export function parseBlueprint(value: unknown): BunderstackBlueprint {
  const blueprint = blueprintSchema.parse(value) as BunderstackBlueprint
  rejectDuplicates(
    'database physical table',
    blueprint.resources.database.tables.map((entry) => entry.physicalName),
  )
  rejectDuplicates(
    'database export table',
    blueprint.resources.database.tables.map((entry) => entry.exportName),
  )
  rejectDuplicates(
    'storage bucket',
    blueprint.resources.storage.buckets.map((entry) => entry.name),
  )
  rejectDuplicates(
    'environment key',
    blueprint.environment.map((entry) => entry.key),
  )
  rejectDuplicates(
    'background job',
    blueprint.background.jobs.map((entry) => entry.name),
  )
  rejectDuplicates(
    'background cron',
    blueprint.background.cron.map((entry) => entry.name),
  )
  rejectDuplicates(
    'background maintenance',
    blueprint.background.maintenance.map((entry) => entry.name),
  )
  if (
    !blueprint.resources.storage.buckets.some(
      (bucket) => bucket.name === blueprint.resources.storage.defaultBucket,
    )
  ) {
    throw new Error(
      '[bunderstack] storage defaultBucket must be declared in storage buckets',
    )
  }
  const workerRequired = blueprint.background.jobs.length > 0
  if (blueprint.background.worker.required !== workerRequired) {
    throw new Error(
      '[bunderstack] background worker.required must match declared queue jobs',
    )
  }
  if (Boolean(blueprint.application.scripts.worker) !== workerRequired) {
    throw new Error(
      '[bunderstack] application worker script must match declared queue jobs',
    )
  }
  return blueprint
}

export function blueprintFromManifest(args: {
  manifest: BunderstackManifest
  generatorVersion: string
  entry: string
  migrationMode: MigrationMode
}): BunderstackBlueprint {
  const workerRequired = args.manifest.background.jobs.length > 0
  return parseBlueprint({
    version: 1,
    generator: { name: 'bunderstack', version: args.generatorVersion },
    application: {
      framework: 'tanstack-start',
      scripts: {
        build: 'build',
        start: 'start',
        ...(workerRequired ? { worker: 'worker' } : {}),
      },
    },
    bunderstack: { entry: args.entry, manifestVersion: 3 },
    resources: {
      database: {
        ...args.manifest.database,
        migrationMode: args.migrationMode,
        tables: sortBy(
          args.manifest.database.tables,
          (entry) => entry.physicalName,
        ),
      },
      storage: {
        ...args.manifest.storage,
        buckets: sortBy(args.manifest.storage.buckets, (entry) => entry.name),
      },
      ...(args.manifest.realtime.required
        ? { realtime: { required: true } }
        : {}),
    },
    environment: sortBy(args.manifest.environment, (entry) => entry.key),
    background: {
      worker: { required: workerRequired },
      jobs: sortBy(args.manifest.background.jobs, (entry) => entry.name),
      cron: sortBy(args.manifest.background.cron, (entry) => entry.name),
      maintenance: sortBy(
        args.manifest.background.maintenance,
        (entry) => entry.name,
      ),
    },
  })
}

export function parseBlueprintYaml(source: string): BunderstackBlueprint {
  return parseBlueprint(parse(source) as unknown)
}

export function serializeBlueprint(value: BunderstackBlueprint): string {
  const blueprint = parseBlueprint(value)
  const options = {
    aliasDuplicateObjects: false,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
    lineWidth: 0,
  } as const
  const source = stringify(
    parseBlueprintYaml(stringify(blueprint, options)),
    options,
  )
  return source.replace(
    /^(\s*schedule: )(.+)$/gm,
    (_match, prefix: string, value: string) => {
      const schedule = value.startsWith('"') ? JSON.parse(value) : value
      return `${prefix}${JSON.stringify(schedule)}`
    },
  )
}
