// src/index.ts
import type { AnyRouter } from '@trpc/server'
import type { Hono as HonoType } from 'hono'

import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import type { StorageAdapter } from './storage/index'
import type { TableAccessInput } from './access'
import type { DbFor } from './db'
import type { StorageConfigInput } from './storage/buckets'

import { resolveAccessUser, validateAndResolveAccess } from './access'
import { createAuth, toAuthSessionResolver, withEmailAuthDefaults } from './auth'
import { resolveConfig, type BunderstackConfig } from './config'
import { resolveRealtimeRedisUrl } from './config'
import { detectDialect } from './dialect'
import { createEmail, emailProviderTag, type EmailFacade } from './email'
import { validateEnv, type EnvConfigInput, type ValidatedEnv } from './env'
import { buildManifest, type BunderstackManifest } from './manifest'
import { createTRPC, type BunderstackTRPC } from './trpc'
import { buildCrudRouter } from './crud'
import { createDb } from './db'
import { buildHandler } from './handler'
import { withInternalTables } from './internal-tables'
import { Lifecycle, type LifecycleStatus } from './lifecycle'
import {
  createJobsBuilder,
  createJobRunner,
  buildCronRouter,
  enqueueJob,
  startJobWorker,
  validateJobsDefs,
} from './jobs/index'
import type {
  BunderstackJobsBuilder,
  EnqueueOptions,
  JobsDefs,
  JobsFacade,
  StartWorkerOptions,
  WorkerHandle,
} from './jobs/index'
import {
  PROVISION_INTERNALS,
  type WithProvisionInternals,
} from './provision-internals'
import { createRealtimeBroker, buildRealtimeRouter } from './realtime/index'
import { createRedisRealtimeBroker } from './realtime/redis'
import { deleteFileWithDerivatives } from './storage/delete'
import { deleteFileMetaRow } from './storage/file-meta'
import { createBucketStorages } from './storage/registry'
import { buildBucketStorageRouter } from './storage/router'
import { sweepOrphans } from './storage/sweep'

type AuthInstance = ReturnType<typeof createAuth>

/** Default age before an unconfirmed `pending` file is treated as an orphan. */
const DEFAULT_PENDING_TTL_MS = 30 * 60_000
/**
 * Public storage facade exposed as `app.storage`. Object-level operations live
 * on the per-bucket adapters; this surface offers the app-wide deletes that
 * must also clean the file-meta row.
 */
export interface StorageFacade {
  /** Delete an object, its transform derivatives, and its file-meta row. `fileId` is `<bucket>/<id>`. */
  delete(fileId: string): Promise<void>
  /** Get the raw adapter for a bucket, or `undefined` if it isn't declared. */
  bucket(name: string): StorageAdapter | undefined
  /**
   * Reap stale `pending` uploads older than `olderThanMs` (default 30m). Runs
   * only when explicitly invoked by the host or local scheduler. Returns
   * the count reaped.
   */
  sweep(olderThanMs?: number): Promise<number>
}

export type AppStartWorkerOptions = Omit<StartWorkerOptions, 'tick'>

/** Bucket names declared in a storage config; `string` when unknowable. */
export type BucketNamesOf<TStorage> = TStorage extends {
  buckets: infer B extends Record<string, unknown>
}
  ? keyof B & string
  : string


export type BunderstackApp<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = undefined,
  TBuckets extends string = string,
  TEnv extends EnvConfigInput | undefined = undefined,
  TRouter = undefined,
  TJobsDefs extends JobsDefs | undefined = undefined,
> = {
  handler: (req: Request) => Promise<Response>
  db: DbFor<TSchema>
  auth: AuthInstance
  storage: StorageFacade
  router: HonoType
  /** Raw tRPC router when the config declared one — escape hatch. */
  trpcRouter?: AnyRouter
  /** Validated env: bunderstack's base vars plus the config's `env` extension. */
  env: ValidatedEnv<TEnv>
  /** Email facade; always present — send() throws when email isn't configured. */
  email: EmailFacade
  /** Job queue facade; always present — enqueue throws when jobs aren't configured. */
  jobs: JobsFacade<TJobsDefs extends JobsDefs ? TJobsDefs : Record<never, never>>
  startWorker(options?: AppStartWorkerOptions): Promise<WorkerHandle>
  close(): Promise<void>
  readonly status: LifecycleStatus
  readonly signal: AbortSignal
  /** Deploy-time introspection: what this app needs provisioned. */
  manifest: BunderstackManifest
  /**
   * Type-only carrier for client inference (`createClient<typeof app>()`).
   * Never assigned at runtime.
   */
  readonly $inferClient?: {
    schema: TSchema
    access: TAccess
    buckets: TBuckets
    trpc: TRouter
  }
}

// Overloads: the builder-callback form and the prebuilt-router/none form are
// separate signatures so the callback's `t` parameter gets contextual typing
// and the router type lands on `$inferClient` without conditional-type
// inference (which breaks under contextual return types). `jobs` needs the
// same split against BOTH trpc forms — a union parameter type (`TJobsDefs |
// (callback => TJobsDefs)`) defeats inference (TS widens TJobsDefs to its
// constraint when a function literal could match either union arm) — hence
// four overloads covering the trpc × jobs option cross product.
export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TRouter extends AnyRouter = AnyRouter,
  const TJobsDefs extends JobsDefs | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    /** Builder callback receiving the pre-wired `t` instance. */
    trpc: (t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => TRouter
    /** Builder callback receiving the pre-wired `j` instance. */
    jobs: (j: BunderstackJobsBuilder<TSchema, ValidatedEnv<TEnv>>) => TJobsDefs
  },
): Promise<BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, TRouter, TJobsDefs>>
export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TRouter extends AnyRouter = AnyRouter,
  const TJobsDefs extends JobsDefs | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    /** Builder callback receiving the pre-wired `t` instance. */
    trpc: (t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => TRouter
    /** Prebuilt job definitions (escape hatch for multi-file setups). */
    jobs?: TJobsDefs
  },
): Promise<BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, TRouter, TJobsDefs>>
export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TRouter extends AnyRouter | undefined = undefined,
  const TJobsDefs extends JobsDefs | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    /** Prebuilt tRPC router (escape hatch for multi-file setups). */
    trpc?: TRouter
    /** Builder callback receiving the pre-wired `j` instance. */
    jobs: (j: BunderstackJobsBuilder<TSchema, ValidatedEnv<TEnv>>) => TJobsDefs
  },
): Promise<BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, TRouter, TJobsDefs>>
export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TRouter extends AnyRouter | undefined = undefined,
  const TJobsDefs extends JobsDefs | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    /** Prebuilt tRPC router (escape hatch for multi-file setups). */
    trpc?: TRouter
    /** Prebuilt job definitions (escape hatch for multi-file setups). */
    jobs?: TJobsDefs
  },
): Promise<BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, TRouter, TJobsDefs>>
export async function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    trpc?:
      | AnyRouter
      | ((t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => AnyRouter)
    jobs?:
      | JobsDefs
      | ((j: BunderstackJobsBuilder<TSchema, ValidatedEnv<TEnv>>) => JobsDefs)
  },
): Promise<
  BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    AnyRouter | undefined,
    JobsDefs | undefined
  >
> {
  const dialect = detectDialect(options.schema)
  const jobsDefs: JobsDefs | undefined = options.jobs
    ? typeof options.jobs === 'function'
      ? options.jobs(createJobsBuilder<TSchema, ValidatedEnv<TEnv>>())
      : (options.jobs as JobsDefs)
    : undefined
  if (jobsDefs) validateJobsDefs(jobsDefs)
  const cronConfigured = Object.values(jobsDefs ?? {}).some(
    (definition) => definition.kind === 'cron',
  )
  // Env is validated FIRST: the app refuses to boot on missing/invalid vars,
  // and everything downstream (config, email, trpc ctx) consumes the result.
  const env = validateEnv(options.env, {
    emailProvider: emailProviderTag(options.email),
    defaultDatabaseUrl:
      dialect === 'pg' ? 'file:./data.pglite' : 'file:./data.db',
    cronConfigured,
  })
  const config = resolveConfig(options, env)
  // Introspection mode (BUNDERSTACK_INTROSPECT=1): deployment platforms import
  // the app declaration only to read `app.manifest`. The boot must never touch
  // the outside world — force an in-memory db (':memory:' is valid for both
  // dialects) and skip Redis below. Env validation is already lenient (env.ts).
  const introspect = process.env.BUNDERSTACK_INTROSPECT === '1'
  if (introspect) {
    config.database.url = ':memory:'
    config.database.authToken = undefined
  }
  const email = createEmail(options.email, { env })
  // Merge bunderstack's internal tables (file-meta, idempotency) into the
  // schema used for the db client + provisioning. CRUD/access stay on the USER
  // schema so internal tables never get a CRUD route.
  const mergedSchema = withInternalTables(options.schema)
  const { db, driver } = await createDb(mergedSchema, {
    ...config.database,
    dialect,
  })
  // `db` is typed with the merged schema (user tables + internal tables) so the
  // storage/idempotency code can query the internal tables. The public surface
  // and CRUD only expose the USER schema. TS can widen the merged-schema db type
  // on its own (storage/auth pass `db` directly), but it can't *narrow* a
  // generic schema view, so this single intentional cast produces the
  // user-facing, per-dialect db type. See `app.db` / crud below.
  const userDb = db as unknown as DbFor<TSchema>
  const auth = createAuth(
    db,
    withEmailAuthDefaults(config.auth, email, Boolean(options.email)),
    dialect,
  )
  // Internal routers consume the narrow AuthSessionResolver contract, not the
  // raw better-auth instance. app.auth still exposes `auth` unchanged.
  const authResolver = toAuthSessionResolver(auth)
  const resolvedAccess = validateAndResolveAccess(
    options.schema,
    options.access,
  )
  const realtimeBufferSize =
    typeof config.realtime === 'object' ? config.realtime.bufferSize : undefined
  const redisUrl =
    config.realtime && !introspect
      ? resolveRealtimeRedisUrl(config.realtime, env)
      : undefined
  const broker = config.realtime
    ? redisUrl
      ? createRedisRealtimeBroker({
          access: resolvedAccess,
          redis: (() => {
            // Redis pub/sub requires a dedicated connection (subscribe puts the client into
            // a restricted state). We use one client for commands and a second for subscribe.
            const cmdClient = new Bun.RedisClient(redisUrl)
            const subClient = new Bun.RedisClient(redisUrl)
            return {
              incr: (key: string) => cmdClient.incr(key),
              publish: (channel: string, message: string) =>
                cmdClient.publish(channel, message),
              subscribe: (channel: string, listener: (msg: string) => void) =>
                subClient.subscribe(channel, listener),
              lpush: (key: string, value: string) =>
                cmdClient.lpush(key, value),
              ltrim: (key: string, start: number, stop: number) =>
                cmdClient.ltrim(key, start, stop),
              lrange: (key: string, start: number, stop: number) =>
                cmdClient.lrange(key, start, stop),
            }
          })(),
          bufferSize: realtimeBufferSize,
        })
      : createRealtimeBroker({
          access: resolvedAccess,
          bufferSize: realtimeBufferSize,
        })
    : undefined
  const crudRouter = buildCrudRouter(options.schema, userDb, {
    auth: authResolver,
    access: resolvedAccess,
    idempotency: options.idempotency,
    broker,
  })
  const realtimeRouter = broker
    ? buildRealtimeRouter(broker, {
        auth: authResolver,
        keepaliveMs:
          typeof config.realtime === 'object'
            ? config.realtime.keepaliveMs
            : undefined,
      })
    : undefined
  const registry = createBucketStorages(config.storage)
  const lifecycle = new Lifecycle()
  const storageRouter = buildBucketStorageRouter({
    registry,
    db,
    auth: authResolver,
  })
  const storage: StorageFacade = {
    async delete(fileId) {
      const bucketName = fileId.split('/')[0] ?? ''
      const entry = registry.get(bucketName)
      if (entry) {
        await deleteFileWithDerivatives(entry.adapter, db, fileId)
      } else {
        // Unknown bucket: no adapter to clean, but still drop the meta row.
        await deleteFileMetaRow(db, fileId)
      }
    },
    bucket(name) {
      return registry.get(name)?.adapter
    },
    sweep(olderThanMs = DEFAULT_PENDING_TTL_MS) {
      return sweepOrphans(registry, db, olderThanMs)
    },
  }
  const jobRunner = jobsDefs
    ? createJobRunner({
        db,
        defs: jobsDefs,
        ctx: { db: userDb, env, email, storage },
      })
    : undefined
  const jobs = {
    async enqueue(name: string, input?: unknown, opts?: EnqueueOptions) {
      if (!jobsDefs) {
        throw new Error(
          '[bunderstack] no jobs configured — add a `jobs` key to createBunderstack',
        )
      }
      const result = await enqueueJob(db, jobsDefs, name, input, opts)
      return result
    },
    tick(now?: number) {
      return jobRunner ? jobRunner.tick(now) : Promise.resolve()
    },
  }
  if (jobRunner) jobRunner.setJobsFacade(jobs)
  const startWorker = async (
    options: AppStartWorkerOptions = {},
  ): Promise<WorkerHandle> => {
    if (!jobRunner) {
      throw new Error('[bunderstack] no queue jobs configured')
    }
    if (lifecycle.status !== 'ready') {
      throw new Error('[bunderstack] application lifecycle is closed')
    }
    const signal = options.signal
      ? AbortSignal.any([lifecycle.signal, options.signal])
      : lifecycle.signal
    const handle = startJobWorker({
      ...options,
      signal,
      tick: (now) => jobRunner.tick(now),
    })
    const unregister = lifecycle.add(() => handle.close())
    void handle.closed.finally(unregister)
    return handle
  }
  const trpcRouter: AnyRouter | undefined =
    typeof options.trpc === 'function'
      ? options.trpc(createTRPC<TSchema, ValidatedEnv<TEnv>>())
      : options.trpc
  const trpcHandler = trpcRouter
    ? (req: Request) =>
        fetchRequestHandler({
          endpoint: '/api/trpc',
          req,
          router: trpcRouter,
          createContext: async () => ({
            db: userDb,
            user: await resolveAccessUser(authResolver, req.headers),
            env,
            email,
            jobs,
            req,
          }),
        })
    : undefined
  const cronRouter =
    jobsDefs && env.BUNDERSTACK_CRON_SECRET
      ? buildCronRouter({
          db,
          defs: jobsDefs,
          ctx: { db: userDb, env, email, storage },
          secret: env.BUNDERSTACK_CRON_SECRET,
          storage,
        })
      : undefined
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
    storageRouter,
    realtimeRouter,
    trpcHandler,
    cronRouter,
    rateLimit: options.rateLimit,
  })

  const app: BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    AnyRouter | undefined,
    JobsDefs | undefined
  > = {
    handler,
    // Internal tables live on the runtime db but stay out of the public type.
    db: userDb,
    auth,
    storage,
    router,
    env,
    email,
    // Runtime facade is untyped (JobsRuntimeFacade); the generic-typed field
    // narrows `enqueue` per-app from the declared job defs — same relationship
    // as `userDb` above.
    jobs: jobs as never,
    startWorker,
    close: () => lifecycle.close(),
    get status() {
      return lifecycle.status
    },
    signal: lifecycle.signal,
    trpcRouter,
    manifest: buildManifest({
      schema: options.schema,
      dialect,
      storage: config.storage,
      envConfig: options.env as EnvConfigInput | undefined,
      realtime: Boolean(config.realtime),
      jobs: jobsDefs,
    }),
  }

  // Hidden handle for the optional `bunderstack/provision` entry. Kept off the
  // public type so provisioning stays opt-in (and drizzle-kit out of this
  // module graph).
  ;(app as WithProvisionInternals)[PROVISION_INTERNALS] = {
    db,
    schema: mergedSchema,
    databaseUrl: config.database.url,
    migrationsFolder: config.database.migrations,
    dialect,
    driver,
  }

  return app
}

export { MAX_LIST_LIMIT } from './list-query'
export { resolveConfig } from './config'
export type {
  BetterAuthConfig,
  BunderstackConfig,
  ResolvedConfig,
} from './config'
export { validateEnv, createClientEnv, BunderstackEnvError } from './env'
export type { EnvConfigInput, BaseEnv, ValidatedEnv } from './env'
export { buildManifest } from './manifest'
export type { BunderstackManifest, ManifestEnvVar } from './manifest'
export { createEmail } from './email'
export type {
  EmailMessage,
  EmailAdapter,
  EmailConfigInput,
  EmailFacade,
} from './email'
export { createTRPC } from './trpc'
export type { BunderstackTRPC, TRPCContext } from './trpc'
export {
  createJobsBuilder,
  signScheduleRequest,
  verifyScheduleRequest,
} from './jobs/index'
export type {
  BunderstackJobsBuilder,
  BackgroundDefinition,
  BackgroundDefs,
  CronDefinition,
  CronInvocation,
  EnqueueOptions,
  JobContext,
  JobDefinition,
  JobsDefs,
  JobsFacade,
  JobsRuntimeFacade,
  QueueJobDefinition,
  QueueJobKeys,
  RunWorkerOptions,
  StartWorkerOptions,
  WorkerHandle,
} from './jobs/index'
export {
  defineAccess,
  validateAndResolveAccess,
  checkAccess,
  AUTH_TABLE_NAMES,
} from './access'
export type {
  TableAccessInput,
  OperationRule,
  AccessContext,
  AccessUser,
} from './access'
export {
  typeid,
  generate as generateTypeId,
  parse as parseTypeId,
  asTypeId,
} from './typeid'
export type { TypeId } from './typeid'
export type { StorageAdapter } from './storage/index'
export type {
  StorageConfigInput,
  BucketConfigInput,
  ResolvedBucket,
} from './storage/buckets'
// StorageFacade is declared+exported inline above.
export type { TransformSpec } from './storage/thumbnails'
