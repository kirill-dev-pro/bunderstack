import type { AnyRouter as AnyORPCRouter } from '@orpc/server'

import type { TableAccessInput } from './access'
import type { BunderstackConfig, RealtimeConfigInput } from './config'
import type { EnvConfigInput, ValidatedEnv } from './env'
import type { BunderstackJobsBuilder, JobsDefs } from './jobs'
import type { BunderstackManifest } from './manifest'
import type { MessagingConfig } from './messaging'
import type { BunderstackApp, BucketNamesOf, RuntimeOverrides } from './runtime'
import type { StorageConfigInput } from './storage/buckets'
import type { TestMethod, TestOptions } from './testing/fixture'

import { BACKEND_INTERNALS, type BackendInternals } from './backend-internals'
import { validateEnv } from './env'
import { assertHostedBlueprintFile } from './hosted-contract'
import { inspectConfig, type InspectedDefinition } from './inspect'
import { materializeBunderstack } from './runtime'

export type StartOptions = {
  env?: Record<string, string | undefined>
}

export type BunderstackBackend<TApp> = {
  inspect(options?: StartOptions): BunderstackManifest
  start(options?: StartOptions): Promise<TApp>
  test: TestMethod<TApp>
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
  TMessaging extends MessagingConfig | undefined = undefined,
> = Omit<
  BunderstackConfig<TSchema, TAccess, TStorage, TEnv, TCustomApiRouter>,
  'realtime' | 'messaging' | 'api'
> & {
  /**
   * An inline `api` or `jobs` builder receives the open `MessagingConfig`, not
   * `TMessaging`. Naming `TMessaging` in a callback parameter makes TypeScript
   * fix it before it reads the sibling `messaging` property, and the whole
   * declaration then loses its inferred channels. Declare the builder in its
   * own module with an annotated parameter to type `ctx.messaging` exactly —
   * `defineApi({ schema, env, messaging })` and `BunderstackJobsBuilder` both
   * take the channel record.
   */
  realtime?: TRealtime
  messaging?: TMessaging
  api?:
    | TCustomApiRouter
    | ((
        builder: import('./api/builder').BunderstackApiBuilder<
          TSchema,
          ValidatedEnv<TEnv>,
          MessagingConfig
        >,
      ) => TCustomApiRouter)
  jobs?:
    | TJobsDefs
    | ((
        builder: BunderstackJobsBuilder<
          TSchema,
          ValidatedEnv<TEnv>,
          MessagingConfig
        >,
      ) => TJobsDefs)
}

export function isBunderstackBackend(
  value: unknown,
): value is BunderstackBackend<unknown> {
  return (
    typeof value === 'object' && value !== null && BACKEND_INTERNALS in value
  )
}

/**
 * The static half of a declaration. `schema` and `env` are resolved before the
 * factory runs, which is what lets an inline `jobs`, `api`, or `auth` builder
 * see the exact table and env types.
 */
export type BunderstackDeclaration<
  TSchema extends Record<string, unknown>,
  TEnv extends EnvConfigInput | undefined,
> = {
  schema: TSchema
  env?: TEnv
}

export function bunderstack<
  TSchema extends Record<string, unknown>,
  const TEnv extends EnvConfigInput | undefined = undefined,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TJobsDefs extends JobsDefs | undefined = undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined = undefined,
  const TRealtime extends RealtimeConfigInput | undefined = undefined,
  const TMessaging extends MessagingConfig | undefined = undefined,
>(
  declaration: BunderstackDeclaration<TSchema, TEnv>,
  factory: (
    env: ValidatedEnv<TEnv>,
  ) => Omit<
    BunderstackDefinitionConfig<
      TSchema,
      TAccess,
      TStorage,
      TEnv,
      TJobsDefs,
      TCustomApiRouter,
      TRealtime,
      TMessaging
    >,
    'schema'
  >,
): BunderstackBackend<
  BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime,
    TMessaging
  >
>
export function bunderstack(
  declaration: BunderstackDeclaration<Record<string, unknown>, EnvConfigInput>,
  factory: (
    env: any,
  ) => Omit<
    BunderstackDefinitionConfig<any, any, any, any, any, any, any, any>,
    'schema'
  >,
): BunderstackBackend<any> {
  const envSchema = declaration.env
  const inspect = (source: Record<string, string | undefined>) => {
    const env = validateEnv(envSchema, { source })
    const config = { schema: declaration.schema, ...factory(env) }
    return inspectConfig(config as never, envSchema, env)
  }

  type App = BunderstackApp<any, any, any, any, any, any, any, any>

  const start = async (
    source: Record<string, string | undefined>,
    overrides: RuntimeOverrides = {},
    inspected: InspectedDefinition = inspect(source),
  ): Promise<App> => {
    if (source.BUNDERSTACK_BLUEPRINT_PATH) {
      await assertHostedBlueprintFile(
        inspected.manifest,
        source.BUNDERSTACK_BLUEPRINT_PATH,
      )
    }
    return materializeBunderstack(
      {
        ...inspected.config,
        jobs: inspected.jobsDefs,
        api: inspected.customApiRouter,
      } as never,
      source,
      overrides,
      inspected.env,
    ) as Promise<App>
  }

  let backend: BunderstackBackend<App>
  const test = (async (options) => {
    const testing = await import('./testing')
    return testing.createTestApp(backend, options)
  }) as TestMethod<App>
  test.configure = (options) =>
    (async (overrides: TestOptions = {}) => {
      const testing = await import('./testing')
      return testing.configureTestApp(backend, options)(overrides)
    }) as never
  backend = {
    inspect: ({ env } = {}) =>
      inspect(env ?? (process.env as Record<string, string | undefined>))
        .manifest,
    start: async ({ env } = {}) =>
      await start(env ?? (process.env as Record<string, string | undefined>)),
    test,
    [BACKEND_INTERNALS]: {
      envSchema,
      inspect,
      start,
    },
  }
  return backend
}
