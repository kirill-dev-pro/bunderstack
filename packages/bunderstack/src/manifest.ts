// src/manifest.ts — deploy-time introspection surface. Pure: consumes already
// resolved config pieces, never reads process.env or touches the network.
// Deployment platforms (Bunderhost) import the app declaration with
// BUNDERSTACK_INTROSPECT=1 and read `app.manifest` to learn what to provision.
import type { ZodType } from 'zod'

import type { Dialect } from './dialect'
import type { EnvConfigInput } from './env'
import type { JobsDefs } from './jobs/define'
import type { ResolvedBucket, ResolvedStorageBuckets } from './storage/buckets'

export type ManifestEnvVar = { key: string; required: boolean }
export type ManifestJob = { name: string; cron?: string }

export type BunderstackManifest = {
  dialect: Dialect
  tables: string[]
  defaultBucket: string
  buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  realtime: boolean
  env: { server: ManifestEnvVar[]; client: ManifestEnvVar[] }
  jobs: ManifestJob[]
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
    dialect: args.dialect,
    tables: Object.keys(args.schema),
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
    jobs: Object.entries(args.jobs ?? {}).map(([name, def]) =>
      def.cron !== undefined ? { name, cron: def.cron } : { name },
    ),
  }
}
