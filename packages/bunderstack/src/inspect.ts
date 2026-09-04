import type { AnyRouter } from '@orpc/server'

import type { BunderstackDefinitionConfig } from './backend'
import type { BaseEnv, EnvConfigInput } from './env'
import type { JobsDefs } from './jobs'
import type { BunderstackManifest } from './manifest'

import { createApiBuilder } from './api/builder'
import { describeApiOperations } from './api/catalog'
import { detectDialect } from './dialect'
import { createJobsBuilder, validateJobsDefs } from './jobs'
import { buildManifest } from './manifest'
import {
  STORAGE_SWEEP_JOB_NAME,
  STORAGE_SWEEP_SCHEDULE,
} from './storage/background'
import { resolveBuckets } from './storage/buckets'

export type AnyDefinitionConfig = BunderstackDefinitionConfig<
  Record<string, unknown>,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>

export type InspectedDefinition = {
  readonly config: AnyDefinitionConfig
  readonly jobsDefs: JobsDefs | undefined
  readonly customApiRouter: AnyRouter | undefined
  readonly manifest: BunderstackManifest
  readonly env: BaseEnv
}

export function inspectConfig(
  input: AnyDefinitionConfig,
  envConfig: EnvConfigInput | undefined,
  env: BaseEnv,
): InspectedDefinition {
  const config = { ...input } as AnyDefinitionConfig
  const dialect = detectDialect(config.schema)
  const jobsDefs = config.jobs
    ? typeof config.jobs === 'function'
      ? config.jobs(createJobsBuilder())
      : config.jobs
    : undefined
  if (jobsDefs) validateJobsDefs(jobsDefs)

  const customApiRouter =
    typeof config.api === 'function'
      ? config.api(createApiBuilder())
      : config.api

  const manifest = buildManifest({
    schema: config.schema,
    dialect,
    migrationsDirectory: config.database.migrations ?? './migrations',
    storage: resolveBuckets(config.storage, {}),
    envConfig,
    messaging: config.messaging,
    realtime: Boolean(config.realtime),
    api: describeApiOperations(customApiRouter),
    jobs: config.storage
      ? {
          ...jobsDefs,
          [STORAGE_SWEEP_JOB_NAME]: {
            kind: 'cron',
            schedule: STORAGE_SWEEP_SCHEDULE,
            handler: () => {},
          },
        }
      : jobsDefs,
  })

  return { config, jobsDefs, customApiRouter, manifest, env }
}
