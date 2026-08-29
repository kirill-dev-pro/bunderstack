import * as v from 'valibot'
import { parse, stringify } from 'yaml'

import type { BunderstackManifest } from './manifest'

import { parseCron } from './jobs/cron'
import { validateStandardSchema } from './standard-schema'

export type MigrationMode = 'migrations' | 'push'
export type ApplicationFramework =
  | 'tanstack-start'
  | 'solid'
  | 'bun-ssr'
  | 'custom'

/**
 * Blueprint form of an environment key. `sensitive` and `description` are
 * optional because blueprints committed before 0.23.0 do not carry them.
 */
export type BlueprintEnvVar = {
  key: string
  required: boolean
  scope: 'server' | 'client'
  sensitive?: boolean
  description?: string
}

export type BunderstackBlueprint = {
  version: 1
  generator: { name: 'bunderstack'; version: string }
  application: {
    framework: ApplicationFramework
    scripts: { build: 'build'; start: 'start'; worker?: 'worker' }
  }
  bunderstack: { entry: string; manifestVersion: 3 }
  resources: {
    database: BunderstackManifest['database'] & { migrationMode: MigrationMode }
    storage: BunderstackManifest['storage']
    realtime?: { required: true }
  }
  environment: BlueprintEnvVar[]
  /** Application-declared procedures. Absent in blueprints written before 0.23.0. */
  api?: { operations: BunderstackManifest['api']['operations'] }
  background: BunderstackManifest['background'] & {
    worker: { required: boolean }
  }
}

const nonEmpty = v.pipe(v.string(), v.minLength(1))
const relativePath = v.pipe(
  nonEmpty,
  v.check(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '' && part !== '..'),
    'entry must be a relative path without traversal',
  ),
)
const cronSchedule = v.pipe(
  nonEmpty,
  v.check((value) => {
    try {
      parseCron(value)
      return true
    } catch {
      return false
    }
  }, 'invalid cron schedule'),
)

// Hosts parse blueprints committed by applications that upgrade bunderstack on
// their own schedule, so a section written by a newer generator has to survive
// an older parser instead of failing the whole file.
function open<TEntries extends v.ObjectEntries>(entries: TEntries) {
  return v.objectWithRest(entries, v.unknown())
}

const blueprintSchema = open({
  version: v.literal(1),
  generator: open({
    name: v.literal('bunderstack'),
    version: nonEmpty,
  }),
  application: open({
    framework: v.picklist(['tanstack-start', 'solid', 'bun-ssr', 'custom']),
    scripts: open({
      build: v.literal('build'),
      start: v.literal('start'),
      worker: v.optional(v.literal('worker')),
    }),
  }),
  bunderstack: open({
    entry: relativePath,
    manifestVersion: v.literal(3),
  }),
  resources: open({
    database: open({
      dialect: v.picklist(['sqlite', 'pg']),
      migrationsDirectory: relativePath,
      migrationMode: v.picklist(['migrations', 'push']),
      tables: v.array(
        open({
          exportName: nonEmpty,
          physicalName: nonEmpty,
          system: v.boolean(),
        }),
      ),
    }),
    storage: open({
      defaultBucket: nonEmpty,
      buckets: v.array(
        open({
          name: nonEmpty,
          visibility: v.picklist(['public', 'private']),
        }),
      ),
    }),
    realtime: v.optional(open({ required: v.literal(true) })),
  }),
  environment: v.array(
    open({
      key: nonEmpty,
      required: v.boolean(),
      scope: v.picklist(['server', 'client']),
      sensitive: v.optional(v.boolean()),
      description: v.optional(v.pipe(nonEmpty, v.maxLength(200))),
    }),
  ),
  api: v.optional(
    open({
      operations: v.array(
        open({
          handle: nonEmpty,
          operationId: nonEmpty,
          effect: v.picklist(['read', 'mutation', 'unknown']),
          method: v.optional(nonEmpty),
          path: v.optional(nonEmpty),
          summary: v.optional(v.pipe(nonEmpty, v.maxLength(200))),
        }),
      ),
    }),
  ),
  background: open({
    worker: open({ required: v.boolean() }),
    jobs: v.array(open({ name: nonEmpty })),
    cron: v.array(
      open({
        name: nonEmpty,
        schedule: cronSchedule,
        timezone: v.literal('UTC'),
      }),
    ),
    maintenance: v.array(
      open({
        name: v.literal('storage-sweep'),
        schedule: cronSchedule,
        timezone: v.literal('UTC'),
      }),
    ),
  }),
})

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
  const blueprint = validateStandardSchema(
    blueprintSchema,
    value,
    'blueprint',
  ) as BunderstackBlueprint
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
  if (blueprint.api)
    rejectDuplicates(
      'api operation',
      blueprint.api.operations.map((entry) => entry.handle),
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

/**
 * Whether a host must treat this key as a secret. A blueprint generated before
 * 0.23.0 has no flag, and server keys are secret by default.
 */
export function isSensitiveEnvVar(entry: BlueprintEnvVar): boolean {
  return entry.sensitive ?? entry.scope === 'server'
}

export function blueprintFromManifest(args: {
  manifest: BunderstackManifest
  generatorVersion: string
  entry: string
  migrationMode: MigrationMode
  framework?: ApplicationFramework
}): BunderstackBlueprint {
  const workerRequired = args.manifest.background.jobs.length > 0
  return parseBlueprint({
    version: 1,
    generator: { name: 'bunderstack', version: args.generatorVersion },
    application: {
      framework: args.framework ?? 'tanstack-start',
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
    api: { operations: args.manifest.api.operations },
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
