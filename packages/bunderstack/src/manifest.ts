// src/manifest.ts — deploy-time introspection surface. Pure: consumes already
// resolved config pieces, never reads process.env or touches the network.
// Deployment platforms (Bunderhost) import the app declaration with
// BUNDERSTACK_INTROSPECT=1 and read `app.manifest` to learn what to provision.
import type { ZodType } from 'zod'

import { getTableName, isTable } from 'drizzle-orm'

import type { Dialect } from './dialect'
import type { EnvConfigInput } from './env'
import type { JobsDefs } from './jobs/define'
import type { ResolvedBucket, ResolvedStorageBuckets } from './storage/buckets'

import {
  bunderstackCronRuns,
  bunderstackFiles,
  bunderstackJobs,
} from './internal-tables'

export type ManifestEnvVar = { key: string; required: boolean }
export type BunderstackManifest = {
  version: 2
  dialect: Dialect
  tables: string[]
  tableMap: Record<string, string>
  systemTables: {
    jobs: string
    files: string
    scheduledRuns: string
  }
  defaultBucket: string
  buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  realtime: boolean
  env: { server: ManifestEnvVar[]; client: ManifestEnvVar[] }
  background: {
    jobs: { name: string }[]
    cron: { name: string; schedule: string; timezone: 'UTC' }[]
    maintenance: { name: 'storage-sweep'; schedule: string }[]
  }
}

function describeTables(
  schema: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) =>
      isTable(value) ? [[key, getTableName(value)]] : [],
    ),
  )
}

function describeSection(
  section: Record<string, ZodType> | undefined,
): ManifestEnvVar[] {
  return Object.entries(section ?? {}).map(([key, schema]) => ({
    key,
    required: !schema.safeParse(undefined).success,
  }))
}

export function buildManifest(args: {
  schema: Record<string, unknown>
  dialect: Dialect
  storage: ResolvedStorageBuckets
  envConfig: EnvConfigInput | undefined
  realtime: boolean
  jobs: JobsDefs | undefined
}): BunderstackManifest {
  return {
    version: 2,
    dialect: args.dialect,
    tables: Object.keys(args.schema),
    tableMap: describeTables(args.schema),
    systemTables: {
      jobs: getTableName(bunderstackJobs),
      files: getTableName(bunderstackFiles),
      scheduledRuns: getTableName(bunderstackCronRuns),
    },
    defaultBucket: args.storage.defaultBucket,
    buckets: [...args.storage.buckets.values()].map((bucket) => ({
      name: bucket.name,
      visibility: bucket.visibility,
    })),
    realtime: args.realtime,
    env: {
      server: describeSection(args.envConfig?.server),
      client: describeSection(args.envConfig?.client),
    },
    background: {
      jobs: Object.entries(args.jobs ?? {})
        .filter(([, def]) => def.kind === 'job')
        .map(([name]) => ({ name })),
      cron: Object.entries(args.jobs ?? {})
        .filter(([, def]) => def.kind === 'cron')
        .map(([name, def]) => ({
          name,
          schedule: def.kind === 'cron' ? def.schedule : '',
          timezone: 'UTC' as const,
        })),
      maintenance: [{ name: 'storage-sweep', schedule: '0 4 * * *' }],
    },
  }
}
