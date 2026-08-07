import { getTableName, isTable } from 'drizzle-orm'
import { z, type ZodType } from 'zod'

import type { Dialect } from './dialect'
import type { EnvConfigInput } from './env'
import type { JobsDefs } from './jobs/define'
import type { ResolvedBucket, ResolvedStorageBuckets } from './storage/buckets'

import {
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
} from './internal-tables'
import { parseCron } from './jobs/cron'

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

const nonEmpty = z.string().min(1)
const migrationDirectory = nonEmpty.refine(
  (value) =>
    value.startsWith('/') ||
    (!value.includes('\\') &&
      value.split('/').every((part) => part !== '..' && part !== '')),
  {
    message:
      'migrationsDirectory must be an absolute path or a relative path without traversal',
  },
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

const manifestSchema = z
  .object({
    version: z.literal(3),
    database: z
      .object({
        dialect: z.enum(['sqlite', 'pg']),
        migrationsDirectory: migrationDirectory,
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
    realtime: z.object({ required: z.boolean() }).strict(),
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
  section: Record<string, ZodType> | undefined,
  scope: ManifestEnvVar['scope'],
): ManifestEnvVar[] {
  return Object.entries(section ?? {}).map(([key, schema]) => ({
    key,
    required: !schema.safeParse(undefined).success,
    scope,
  }))
}

function systemTables() {
  return [
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
  const manifest = manifestSchema.parse(value) as BunderstackManifest
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
