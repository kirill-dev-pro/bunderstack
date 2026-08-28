import type { AnyRouter as AnyORPCRouter } from '@orpc/server'

import type { TableAccessInput } from './access'
import type { BunderstackConfig } from './config'
import type { EnvConfigInput, ValidatedEnv } from './env'
import type { BunderstackJobsBuilder, JobsDefs } from './jobs'
import type { BunderstackManifest } from './manifest'
import type { BunderstackApp, BucketNamesOf, RuntimeOverrides } from './runtime'
import type { StorageConfigInput } from './storage/buckets'
import type { TestFixture, TestOptions } from './testing/fixture'

import { BACKEND_INTERNALS, type BackendInternals } from './backend-internals'
import { detectDialect } from './dialect'
import { emailProviderTag } from './email'
import { createJobsBuilder, validateJobsDefs } from './jobs'
import { buildManifest } from './manifest'
import { materializeBunderstack } from './runtime'
import {
  STORAGE_SWEEP_JOB_NAME,
  STORAGE_SWEEP_SCHEDULE,
} from './storage/background'
import { resolveBuckets } from './storage/buckets'

export type StartOptions = {
  env?: Record<string, string | undefined>
}

export type BunderstackBackend<TApp> = {
  readonly manifest: BunderstackManifest
  start(options?: StartOptions): Promise<TApp>
  test(options?: TestOptions): Promise<TestFixture<TApp>>
  readonly [BACKEND_INTERNALS]: BackendInternals<TApp>
}

export type BunderstackDefinitionConfig<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = undefined,
  TStorage extends StorageConfigInput | undefined = undefined,
  TEnv extends EnvConfigInput | undefined = undefined,
  TJobsDefs extends JobsDefs | undefined = undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined = undefined,
  TRealtime = undefined,
> = Omit<
  BunderstackConfig<TSchema, TAccess, TStorage, TEnv, TCustomApiRouter>,
  'realtime'
> & {
  realtime?: TRealtime
  jobs?:
    | TJobsDefs
    | ((
        builder: BunderstackJobsBuilder<TSchema, ValidatedEnv<TEnv>>,
      ) => TJobsDefs)
}

export function isBunderstackBackend(
  value: unknown,
): value is BunderstackBackend<unknown> {
  return (
    typeof value === 'object' && value !== null && BACKEND_INTERNALS in value
  )
}

export function bunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  const TJobsDefs extends JobsDefs | undefined = undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined = undefined,
  const TRealtime extends BunderstackConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TCustomApiRouter
  >['realtime'] = undefined,
>(
  config: BunderstackDefinitionConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >,
): BunderstackBackend<
  BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >
> {
  const dialect = detectDialect(config.schema)
  const jobsDefs = config.jobs
    ? typeof config.jobs === 'function'
      ? config.jobs(createJobsBuilder<TSchema, ValidatedEnv<TEnv>>())
      : config.jobs
    : undefined
  if (jobsDefs) validateJobsDefs(jobsDefs)

  const manifest = buildManifest({
    schema: config.schema,
    dialect,
    migrationsDirectory: config.database.migrations ?? './migrations',
    storage: resolveBuckets(config.storage, {}),
    envConfig: config.env,
    emailProvider: emailProviderTag(config.email),
    realtime: Boolean(config.realtime),
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

  type App = BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >

  const start = (
    source: Record<string, string | undefined>,
    overrides: RuntimeOverrides = {},
  ): Promise<App> =>
    materializeBunderstack(
      { ...config, jobs: jobsDefs } as never,
      source,
      overrides,
    ) as Promise<App>

  let backend: BunderstackBackend<App>
  backend = {
    manifest,
    start: ({ env } = {}) =>
      start(env ?? (process.env as Record<string, string | undefined>)),
    async test(options) {
      const testing = await import('./testing')
      return testing.createTestApp(backend, options)
    },
    [BACKEND_INTERNALS]: { declaration: { config, jobsDefs }, start },
  }
  return backend
}
