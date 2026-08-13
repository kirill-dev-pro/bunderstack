import type { StandardSchemaV1 } from '@standard-schema/spec'

import { getTableName, isTable } from 'drizzle-orm'
import * as v from 'valibot'

import type { Dialect } from './dialect'
import type { EnvConfigInput } from './env'
import type { JobsDefs } from './jobs/define'
import type { ResolvedBucket, ResolvedStorageBuckets } from './storage/buckets'

import {
  bunderstackEmailEvents,
  bunderstackEmails,
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
} from './internal-tables'
import { parseCron } from './jobs/cron'
import {
  StandardSchemaValidationError,
  validateStandardSchema,
} from './standard-schema'

export type ManifestEnvVar = {
  key: string
  required: boolean
  scope: 'server' | 'client'
}

export type BunderstackManifest = {
  version: 3
  database: {
    dialect: Dialect
    migrationsDirectory: string
    tables: { exportName: string; physicalName: string; system: boolean }[]
  }
  storage: {
    defaultBucket: string
    buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  }
  realtime: { required: boolean }
  environment: ManifestEnvVar[]
  background: {
    jobs: { name: string }[]
    cron: { name: string; schedule: string; timezone: 'UTC' }[]
    maintenance: {
      name: 'storage-sweep'
      schedule: string
      timezone: 'UTC'
    }[]
  }
}

const nonEmpty = v.pipe(v.string(), v.minLength(1))
const migrationDirectory = v.pipe(
  nonEmpty,
  v.check(
    (value) =>
      value.startsWith('/') ||
      (!value.includes('\\') &&
        value.split('/').every((part) => part !== '..' && part !== '')),
    'migrationsDirectory must be an absolute path or a relative path without traversal',
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

const manifestSchema = v.strictObject({
  version: v.literal(3),
  database: v.strictObject({
    dialect: v.picklist(['sqlite', 'pg']),
    migrationsDirectory: migrationDirectory,
    tables: v.array(
      v.strictObject({
        exportName: nonEmpty,
        physicalName: nonEmpty,
        system: v.boolean(),
      }),
    ),
  }),
  storage: v.strictObject({
    defaultBucket: nonEmpty,
    buckets: v.array(
      v.strictObject({
        name: nonEmpty,
        visibility: v.picklist(['public', 'private']),
      }),
    ),
  }),
  realtime: v.strictObject({ required: v.boolean() }),
  environment: v.array(
    v.strictObject({
      key: nonEmpty,
      required: v.boolean(),
      scope: v.picklist(['server', 'client']),
    }),
  ),
  background: v.strictObject({
    jobs: v.array(v.strictObject({ name: nonEmpty })),
    cron: v.array(
      v.strictObject({
        name: nonEmpty,
        schedule: cronSchedule,
        timezone: v.literal('UTC'),
      }),
    ),
    maintenance: v.array(
      v.strictObject({
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

function describeTables(schema: Record<string, unknown>) {
  const systemNames = new Set<string>(
    systemTables().map((table) => table.physicalName),
  )
  return sortBy(
    Object.entries(schema).flatMap(([exportName, value]) =>
      isTable(value) && !systemNames.has(getTableName(value))
        ? [{ exportName, physicalName: getTableName(value), system: false }]
        : [],
    ),
    (entry) => entry.physicalName,
  )
}

function describeSection(
  section: Record<string, StandardSchemaV1> | undefined,
  scope: ManifestEnvVar['scope'],
): ManifestEnvVar[] {
  return Object.entries(section ?? {}).map(([key, schema]) => {
    let required = false
    try {
      validateStandardSchema(schema, undefined, 'env')
    } catch (error) {
      if (!(error instanceof StandardSchemaValidationError)) throw error
      required = true
    }
    return { key, required, scope }
  })
}

function systemTables() {
  return [
    {
      exportName: '_system.emailEvents',
      physicalName: getTableName(bunderstackEmailEvents),
      system: true,
    },
    {
      exportName: '_system.emails',
      physicalName: getTableName(bunderstackEmails),
      system: true,
    },
    {
      exportName: '_system.files',
      physicalName: getTableName(bunderstackFiles),
      system: true,
    },
    {
      exportName: '_system.idempotency',
      physicalName: getTableName(bunderstackIdempotency),
      system: true,
    },
    {
      exportName: '_system.jobs',
      physicalName: getTableName(bunderstackJobs),
      system: true,
    },
  ]
}

export function parseManifest(value: unknown): BunderstackManifest {
  const manifest = validateStandardSchema(
    manifestSchema,
    value,
    'manifest',
  ) as BunderstackManifest
  rejectDuplicates(
    'database physical table',
    manifest.database.tables.map((entry) => entry.physicalName),
  )
  rejectDuplicates(
    'database export table',
    manifest.database.tables.map((entry) => entry.exportName),
  )
  rejectDuplicates(
    'storage bucket',
    manifest.storage.buckets.map((entry) => entry.name),
  )
  rejectDuplicates(
    'environment key',
    manifest.environment.map((entry) => entry.key),
  )
  rejectDuplicates(
    'background job',
    manifest.background.jobs.map((entry) => entry.name),
  )
  rejectDuplicates(
    'background cron',
    manifest.background.cron.map((entry) => entry.name),
  )
  rejectDuplicates(
    'background maintenance',
    manifest.background.maintenance.map((entry) => entry.name),
  )
  return manifest
}

export function buildManifest(args: {
  schema: Record<string, unknown>
  dialect: Dialect
  migrationsDirectory: string
  storage: ResolvedStorageBuckets
  envConfig: EnvConfigInput | undefined
  emailProvider: string | undefined
  realtime: boolean
  jobs: JobsDefs | undefined
}): BunderstackManifest {
  const environment = [
    ...describeSection(args.envConfig?.server, 'server'),
    ...describeSection(args.envConfig?.client, 'client'),
    ...(args.emailProvider === 'resend'
      ? [{ key: 'RESEND_API_KEY', required: true, scope: 'server' as const }]
      : []),
    ...(args.emailProvider === 'smtp'
      ? [{ key: 'SMTP_URL', required: true, scope: 'server' as const }]
      : []),
  ]
  rejectDuplicates(
    'environment key',
    environment.map((entry) => entry.key),
  )

  return parseManifest({
    version: 3,
    database: {
      dialect: args.dialect,
      migrationsDirectory: args.migrationsDirectory,
      tables: sortBy(
        [...systemTables(), ...describeTables(args.schema)],
        (entry) => entry.physicalName,
      ),
    },
    storage: {
      defaultBucket: args.storage.defaultBucket,
      buckets: sortBy(
        [...args.storage.buckets.values()].map((bucket) => ({
          name: bucket.name,
          visibility: bucket.visibility,
        })),
        (bucket) => bucket.name,
      ),
    },
    realtime: { required: args.realtime },
    environment: sortBy(environment, (entry) => entry.key),
    background: {
      jobs: sortBy(
        Object.entries(args.jobs ?? {})
          .filter(([, def]) => def.kind === 'job')
          .map(([name]) => ({ name })),
        (entry) => entry.name,
      ),
      cron: sortBy(
        Object.entries(args.jobs ?? {})
          .filter(([, def]) => def.kind === 'cron')
          .map(([name, def]) => ({
            name,
            schedule: def.kind === 'cron' ? def.schedule : '',
            timezone: 'UTC' as const,
          })),
        (entry) => entry.name,
      ),
      maintenance: [
        {
          name: 'storage-sweep',
          schedule: '0 4 * * *',
          timezone: 'UTC' as const,
        },
      ],
    },
  })
}
