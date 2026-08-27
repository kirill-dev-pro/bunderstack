import type { AnyRouter as AnyORPCRouter } from '@orpc/server'
// src/runtime.ts

import { SmartCoercionHandlerPlugin } from '@orpc/json-schema'
import { OpenAPIGenerator, OpenAPIGeneratorError } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { RPCHandler } from '@orpc/server/fetch'
import { ValibotToJsonSchemaConverter } from '@orpc/valibot'

import type { TableAccessInput } from './access'
import type { BunderstackApiBuilder } from './api/builder'
import type { RealtimeApiRouter } from './api/realtime-router'
import type {
  CrudApiRouterFor,
  MergeApiRouterTypes,
  UnifiedApiRouter,
} from './api/types'
import type { RuntimeTestingHandle } from './backend-internals'
import type { DatabaseConnection } from './database/adapter'
import type { DbFor } from './db'
import type {
  BunderstackJobsBuilder,
  EnqueueOptions,
  JobsDefs,
  JobsFacade,
  StartWorkerOptions,
  WorkerHandle,
} from './jobs/index'
import type {
  ResolvedStorageBuckets,
  StorageConfigInput,
} from './storage/buckets'
import type { StorageAdapter } from './storage/index'

import { validateAndResolveAccess } from './access'
import { createApiBuilder } from './api/builder'
import { createApiContext } from './api/context'
import { buildCrudApiRouter } from './api/crud-router'
import { mergeOpenAPISpecs } from './api/openapi'
import { buildRealtimeApiRouter } from './api/realtime-router'
import { buildApiRegistry, normalizeForeignOpenAPISpec } from './api/registry'
import { buildApiRouter } from './api/router'
import { buildStorageApiRouter } from './api/storage-router'
import {
  createAuth,
  toAuthSessionResolver,
  withEmailAuthDefaults,
} from './auth'
import { resolveConfig, type BunderstackConfig } from './config'
import { resolveAuthConfig, resolveRealtimeRedisUrl } from './config'
import { createDb } from './db'
import { detectDialect } from './dialect'
import {
  createEmail,
  emailProviderTag,
  type EmailAdapter,
  type EmailFacade,
} from './email'
import { validateEnv, type EnvConfigInput, type ValidatedEnv } from './env'
import { buildHandler } from './handler'
import { withInternalTables } from './internal-tables'
import {
  createJobsBuilder,
  createJobRunner,
  enqueueJob,
  startJobWorker,
  validateJobsDefs,
} from './jobs/index'
import { Lifecycle, type LifecycleStatus } from './lifecycle'
import {
  PROVISION_INTERNALS,
  type WithProvisionInternals,
} from './provision-internals'
import {
  createRealtimeFacade,
  type RealtimeFacade,
  type RealtimeTransport,
} from './realtime/facade'
import {
  createMemoryRealtimePublisher,
  createRedisRealtimePublisher,
} from './realtime/publisher'
import {
  STORAGE_SWEEP_JOB_NAME,
  STORAGE_SWEEP_SCHEDULE,
} from './storage/background'
import { deleteFileWithDerivatives } from './storage/delete'
import { deleteFileMetaRow, insertReadyFile } from './storage/file-meta'
import { createStorageOperations } from './storage/operations'
import { createBucketStorages } from './storage/registry'
import { sweepOrphans } from './storage/sweep'

export type AuthInstance = ReturnType<typeof createAuth>

export type RuntimeOverrides = {
  database?: DatabaseConnection
  resolvedStorage?: ResolvedStorageBuckets
  emailAdapter?: EmailAdapter
  forceMemoryRealtime?: boolean
  backgroundAutoStart?: false
  /** Private callback used by backend.test(); never exposed on the app. */
  captureTestingHandle?: (handle: RuntimeTestingHandle) => void
}

function waitForWorkerShutdown(
  signal: AbortSignal,
  installProcessListeners: boolean,
): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done)
      if (installProcessListeners) {
        process.removeListener('SIGINT', done)
        process.removeListener('SIGTERM', done)
      }
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    if (installProcessListeners) {
      process.once('SIGINT', done)
      process.once('SIGTERM', done)
    }
  })
}

/** Default age before an unconfirmed `pending` file is treated as an orphan. */
const DEFAULT_PENDING_TTL_MS = 30 * 60_000
/**
 * Public storage facade exposed as `app.storage`. Object-level operations live
 * on the per-bucket adapters; this surface offers the app-wide deletes that
 * must also clean the file-meta row.
 */
export interface StorageFacade {
  /** Delete a file row and purge all underlying storage derivatives. */
  delete(fileId: string): Promise<void>
  /** Low-level access to the underlying storage adapter for a bucket. */
  bucket(name: string): StorageAdapter | undefined
  /**
   * Reap stale `pending` uploads older than `olderThanMs` (default 30m). Runs
   * only when explicitly invoked by the host or local scheduler. Returns
   * the count reaped.
   */
  sweep(olderThanMs?: number): Promise<number>
  /**
   * Get a public or presigned download URL for a file key.
   * Returns a presigned S3 URL when S3 is configured, or local proxy route `/api/files/...` in development.
   */
  getUrl(
    key: string,
    opts?: { bucket?: string; expiresIn?: number },
  ): Promise<string>
  /**
   * Upload bytes as a ready file and register it in file_meta so it is
   * accessible via `GET /api/files/<key>`. Use this for server-generated
   * files (e.g. generated PDFs) that are not uploaded by end-users.
   */
  upload(
    key: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string,
    opts?: { ownerId?: string; filename?: string },
  ): Promise<void>
}

export type AppStartWorkerOptions = Omit<StartWorkerOptions, 'tick'>
export type AppRunWorkerOptions = AppStartWorkerOptions & {
  /**
   * Permit process-local realtime in a standalone worker.
   *
   * Use only when job handlers never call ctx.realtime.publish(). Publications
   * made through the memory broker cannot reach SSE clients in another process.
   */
  allowProcessLocalRealtime?: boolean
}
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
  TJobsDefs extends JobsDefs | undefined = undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined = undefined,
  TRealtime = undefined,
> = {
  handler: (req: Request) => Promise<Response>
  db: DbFor<TSchema>
  auth: AuthInstance
  storage: StorageFacade
  /** Validated env: bunderstack's base vars plus the config's `env` extension. */
  env: ValidatedEnv<TEnv>
  /** Email facade; always present — send() throws when email isn't configured. */
  email: EmailFacade
  /** Job queue facade; always present — enqueue throws when jobs aren't configured. */
  jobs: JobsFacade<
    TJobsDefs extends JobsDefs ? TJobsDefs : Record<never, never>
  >
  /** Typed custom row publication; enabled=false/no-op when realtime is off. */
  realtime: RealtimeFacade<TSchema>
  startWorker(options?: AppStartWorkerOptions): Promise<WorkerHandle>
  /** Run a queue worker until aborted, then close the application. */
  runWorker(options?: AppRunWorkerOptions): Promise<void>
  close(): Promise<void>
  /** True when this process is running the background tick loop. */
  readonly backgroundRunning: boolean
  readonly status: LifecycleStatus
  readonly signal: AbortSignal
  /**
   * Type-only carrier for client inference (`createClient<typeof app>()`).
   * Never assigned at runtime.
   */
  readonly $inferClient?: {
    schema: TSchema
    access: TAccess
    buckets: TBuckets
    api: MergeApiRouterTypes<
      UnifiedApiRouter<
        CrudApiRouterFor<
          TSchema,
          TAccess,
          [TRealtime] extends [false | undefined] ? false : true
        >,
        TCustomApiRouter
      >,
      [TRealtime] extends [false | undefined] ? {} : RealtimeApiRouter
    >
  }
}

export function materializeBunderstack<
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
  options: BunderstackConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TCustomApiRouter
  > & {
    realtime?: TRealtime
    jobs?:
      | TJobsDefs
      | ((j: BunderstackJobsBuilder<TSchema, ValidatedEnv<TEnv>>) => TJobsDefs)
  },
  source: Record<string, string | undefined>,
  overrides?: RuntimeOverrides,
): Promise<
  BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    TJobsDefs,
    TCustomApiRouter,
    TRealtime
  >
>
export async function materializeBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TCustomApiRouter extends AnyORPCRouter | undefined = undefined,
  const TRealtime extends BunderstackConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TCustomApiRouter
  >['realtime'] = undefined,
>(
  options: BunderstackConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TCustomApiRouter
  > & {
    realtime?: TRealtime
    jobs?:
      | JobsDefs
      | ((j: BunderstackJobsBuilder<TSchema, ValidatedEnv<TEnv>>) => JobsDefs)
  },
  source: Record<string, string | undefined>,
  overrides: RuntimeOverrides = {},
): Promise<
  BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    JobsDefs | undefined,
    TCustomApiRouter,
    TRealtime
  >
> {
  const dialect = detectDialect(options.schema)
  const jobsDefs: JobsDefs | undefined = options.jobs
    ? typeof options.jobs === 'function'
      ? options.jobs(createJobsBuilder<TSchema, ValidatedEnv<TEnv>>())
      : (options.jobs as JobsDefs)
    : undefined
  if (jobsDefs) validateJobsDefs(jobsDefs)
  // Env is validated FIRST: the app refuses to boot on missing/invalid vars,
  // and everything downstream consumes the result.
  const env = validateEnv(options.env, {
    emailProvider:
      overrides.emailAdapter === undefined
        ? (source.BUNDERSTACK_EMAIL_PROVIDER ?? emailProviderTag(options.email))
        : undefined,
    defaultDatabaseUrl:
      dialect === 'pg' ? 'file:./data.pglite' : 'file:./data.db',
    source,
  })
  const resolvedConfig = resolveConfig(options, env, source)
  const config = {
    ...resolvedConfig,
    database: overrides.database
      ? { ...resolvedConfig.database, ...overrides.database }
      : resolvedConfig.database,
    storage: overrides.resolvedStorage ?? resolvedConfig.storage,
  }
  // Merge bunderstack's internal tables (file-meta, idempotency) into the
  // schema used for the db client + provisioning. CRUD/access stay on the USER
  // schema so internal tables never get a CRUD route.
  const mergedSchema = withInternalTables(options.schema)
  const lifecycle = new Lifecycle()
  const {
    db,
    driver,
    close: closeDatabase,
  } = await createDb(mergedSchema, {
    ...config.database,
    dialect,
  })
  const email = createEmail(options.email, {
    env,
    db,
    adapterOverride: overrides.emailAdapter,
  })
  if (closeDatabase) lifecycle.add(closeDatabase)
  try {
    // `db` is typed with the merged schema (user tables + internal tables) so the
    // storage/idempotency code can query the internal tables. The public surface
    // and CRUD only expose the USER schema. TS can widen the merged-schema db type
    // on its own (storage/auth pass `db` directly), but it can't *narrow* a
    // generic schema view, so this single intentional cast produces the
    // user-facing, per-dialect db type. See `app.db` / crud below.
    const userDb = db as unknown as DbFor<TSchema>
    // An `auth` builder gets the user-facing db, so better-auth hooks in another
    // file can write through the app's own connection without importing the app.
    const authConfig = resolveAuthConfig(config.auth, { db: userDb, env })
    const auth = createAuth(
      db,
      withEmailAuthDefaults(authConfig, email, Boolean(options.email)),
      dialect,
      options.schema as Record<string, unknown>,
    )
    // Internal routers consume the narrow AuthSessionResolver contract, not the
    // raw better-auth instance. app.auth still exposes `auth` unchanged.
    const authResolver = options.authResolver ?? toAuthSessionResolver(auth)
    const resolvedAccess = validateAndResolveAccess(
      options.schema,
      options.access,
    )
    const realtimeBufferSize =
      typeof config.realtime === 'object'
        ? config.realtime.bufferSize
        : undefined
    const realtimeResumeSeconds =
      typeof config.realtime === 'object'
        ? config.realtime.resumeSeconds
        : undefined
    const configuredRedisUrl = config.realtime
      ? resolveRealtimeRedisUrl(config.realtime, env, source)
      : undefined
    const redisUrl = overrides.forceMemoryRealtime
      ? undefined
      : configuredRedisUrl
    const publisher = config.realtime
      ? redisUrl
        ? (() => {
            const redis = new Bun.RedisClient(redisUrl)
            const subscriber = redis.duplicate()
            lifecycle.add(async () => {
              redis.close()
              ;(await subscriber).close()
            })
            return createRedisRealtimePublisher(redis, subscriber, {
              prefix: source.BUNDERSTACK_REALTIME_PREFIX ?? 'bunderstack:',
              maxBufferedEvents: realtimeBufferSize,
              resumeSeconds: realtimeResumeSeconds,
            })
          })()
        : createMemoryRealtimePublisher({
            maxBufferedEvents: realtimeBufferSize,
            resumeSeconds: realtimeResumeSeconds,
          })
      : undefined
    const runtimeRealtimeTransport: RealtimeTransport = !publisher
      ? 'disabled'
      : redisUrl
        ? 'redis'
        : 'memory'
    const realtime = createRealtimeFacade<TSchema>(
      publisher,
      runtimeRealtimeTransport,
      options.schema,
    )
    const registry = createBucketStorages(config.storage)
    const storageOperations = createStorageOperations({
      registry,
      db,
    })
    const storageApiRouter = buildStorageApiRouter(registry, storageOperations)
    const realtimeApiRouter = buildRealtimeApiRouter(publisher, resolvedAccess)
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
      async getUrl(key, opts = {}) {
        const bucketName =
          opts.bucket ?? key.split('/')[0] ?? config.storage.defaultBucket
        const adapter = registry.get(bucketName)?.adapter
        if (adapter?.presignGet) {
          return adapter.presignGet(key, {
            expiresIn: opts.expiresIn ?? 3600,
          })
        }
        return `/api/files/${key}`
      },
      async upload(key, body, contentType, opts = {}) {
        const bucketName = key.split('/')[0] ?? ''
        const adapter = registry.get(bucketName)?.adapter
        if (!adapter) throw new Error(`Unknown bucket: ${bucketName}`)
        const u8 = body instanceof Uint8Array ? body : new Uint8Array(body)
        const buf: ArrayBuffer = u8.buffer.slice(
          u8.byteOffset,
          u8.byteOffset + u8.byteLength,
        ) as ArrayBuffer
        await adapter.upload(key, buf, contentType)
        await insertReadyFile(db, {
          fileId: key,
          bucket: bucketName,
          ownerId: opts.ownerId ?? null,
          scopeJson: null,
          filename: opts.filename ?? key.split('/').at(-1) ?? null,
          contentType,
          size: buf.byteLength,
        })
      },
    }
    const storageConfigured = Boolean(options.storage)
    // The storage sweep used to be a hardcoded maintenance route. It is an
    // ordinary cron now, so it inherits retries, timeout and onFailed.
    const resolvedDefs: JobsDefs | undefined = storageConfigured
      ? {
          ...jobsDefs,
          [STORAGE_SWEEP_JOB_NAME]: {
            kind: 'cron',
            schedule: STORAGE_SWEEP_SCHEDULE,
            handler: async () => {
              await storage.sweep()
            },
          },
        }
      : jobsDefs

    const jobRunner = resolvedDefs
      ? createJobRunner({
          db,
          defs: resolvedDefs,
          ctx: { db: userDb, env, email, storage, realtime },
        })
      : undefined
    let enqueueNow: number | undefined
    const jobs = {
      async enqueue(name: string, input?: unknown, opts?: EnqueueOptions) {
        if (!resolvedDefs) {
          throw new Error(
            '[bunderstack] no jobs configured — add a `jobs` key to bunderstack',
          )
        }
        const result = await enqueueJob(
          db,
          resolvedDefs,
          name,
          input,
          opts,
          enqueueNow,
        )
        return result
      },
      tick(now?: number) {
        return jobRunner
          ? jobRunner.tick(now)
          : Promise.resolve({ claimed: 0, ran: 0, failed: 0 })
      },
    }
    if (jobRunner) jobRunner.setJobsFacade(jobs)
    overrides.captureTestingHandle?.({
      async tick(now) {
        const previous = enqueueNow
        enqueueNow = now
        try {
          return await jobs.tick(now)
        } finally {
          enqueueNow = previous
        }
      },
      inspect: (now) =>
        jobRunner
          ? jobRunner.inspect(now)
          : Promise.resolve({ runnable: 0, failed: [] }),
    })
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
        // The runtime loop only cares that a tick completed; TickResult is for
        // callers that invoke tick() directly.
        tick: async (now) => {
          await jobRunner.tick(now)
        },
      })
      const unregister = lifecycle.add(() => handle.close())
      void handle.closed.finally(unregister)
      return handle
    }
    const runWorker = async (
      options: AppRunWorkerOptions = {},
    ): Promise<void> => {
      if (
        realtime.transport === 'memory' &&
        !options.allowProcessLocalRealtime
      ) {
        throw new Error(
          '[bunderstack] runWorker() cannot deliver realtime events through the in-memory broker. Configure REDIS_URL or realtime.redis, embed the worker with startWorker(), or pass allowProcessLocalRealtime: true only when jobs never publish realtime.',
        )
      }
      const {
        allowProcessLocalRealtime: _allowProcessLocalRealtime,
        ...workerOptions
      } = options
      const handle = await startWorker(workerOptions)
      try {
        const signal = workerOptions.signal
          ? AbortSignal.any([lifecycle.signal, workerOptions.signal])
          : lifecycle.signal
        await waitForWorkerShutdown(signal, !workerOptions.signal)
      } finally {
        await handle.close()
        await lifecycle.close()
      }
    }
    const crudApiRouter = buildCrudApiRouter<
      TSchema,
      TAccess,
      [TRealtime] extends [false | undefined] ? false : true
    >(options.schema, userDb, {
      access: resolvedAccess,
      idempotency: options.idempotency,
      realtime,
      livePublisher: publisher,
    })

    const customApiRouter =
      typeof options.api === 'function'
        ? (
            options.api as (
              builder: BunderstackApiBuilder<TSchema, ValidatedEnv<TEnv>>,
            ) => TCustomApiRouter
          )(createApiBuilder<TSchema, ValidatedEnv<TEnv>>())
        : options.api

    const nativeRouter = buildApiRouter({
      crud: crudApiRouter as Record<string, unknown>,
      storage: storageApiRouter as Record<string, unknown>,
      realtime: realtimeApiRouter as Record<string, unknown> | undefined,
      custom: customApiRouter as Record<string, unknown> | undefined,
      middleware: options.middleware,
    }) as any

    const authOpenAPISpecRaw =
      options.openapi &&
      auth.api &&
      'generateOpenAPISchema' in auth.api &&
      typeof auth.api.generateOpenAPISchema === 'function'
        ? await auth.api.generateOpenAPISchema()
        : undefined

    const authOpenAPISpec = authOpenAPISpecRaw
      ? normalizeForeignOpenAPISpec(authOpenAPISpecRaw, {
          prefix: '/api/auth',
          source: 'auth',
        })
      : undefined

    await buildApiRegistry({
      nativeRouter,
      foreignSpecs: authOpenAPISpec ? [authOpenAPISpec] : [],
      reservedCoreHandles: new Set([
        'health',
        ...(publisher ? ['realtime.changes'] : []),
        ...[...registry.keys()].flatMap((name) =>
          [
            'prepareUpload',
            'upload',
            'confirmUpload',
            'download',
            'delete',
          ].map((operation) => `files.${name}.${operation}`),
        ),
      ]),
    })

    const valibotConverter = new ValibotToJsonSchemaConverter()

    const combinedOpenAPISpec = options.openapi
      ? mergeOpenAPISpecs({
          nativeSpec: await new OpenAPIGenerator({
            converters: [
              valibotConverter,
              {
                condition: (schema: any) =>
                  Boolean(
                    schema?.['~standard'] && !schema['~standard'].jsonSchema,
                  ),
                convert: (schema: any) => {
                  const vendor = schema?.['~standard']?.vendor ?? 'unknown'
                  throw new OpenAPIGeneratorError(
                    `No JSON Schema converter is configured for Standard Schema vendor "${vendor}"`,
                  )
                },
              },
            ],
          }).generate(nativeRouter),
          authSpec: authOpenAPISpec,
        })
      : undefined

    const openapiHandler = new OpenAPIHandler(nativeRouter, {
      // Query strings and form bodies are strings; this coerces them to the
      // types each procedure's input schema declares, so schemas stay honest
      // (`v.number()`, not a string-union pipe) and REST matches RPC.
      plugins: [
        new SmartCoercionHandlerPlugin({ converters: [valibotConverter] }),
      ],
      customErrorResponseBodyEncoder: (error: any) => {
        if (
          error?.code === 'INTERNAL_SERVER_ERROR' ||
          !error?.status ||
          error.status >= 500
        ) {
          console.error(
            '[bunderstack-api] 500 Internal Server Error:',
            error?.cause ?? error,
          )
        }
        return {
          error: error.message,
          code: error.data?.code ?? error.code,
          // oRPC reports schema failures as `data.issues`; forwarding them tells
          // the client which field was rejected instead of just "invalid".
          ...(error.data?.details !== undefined
            ? { details: error.data.details }
            : error.data?.issues !== undefined
              ? { details: error.data.issues }
              : {}),
        }
      },
      fetchInterceptors: [
        async (options) => {
          const res = await options.next()
          if (res.matched && options.context.resHeaders) {
            options.context.resHeaders.forEach((v: string, k: string) =>
              res.response.headers.set(k, v),
            )
          }
          return res
        },
      ],
    })
    // No custom error encoding here: the RPC protocol owns its error body, and
    // `mapBunderstackErrors` already logs unhandled procedure errors for every
    // transport before rethrowing them.
    const rpcHandler = new RPCHandler(nativeRouter)

    const apiHandler = async (req: Request): Promise<Response | null> => {
      const urlString = typeof req === 'string' ? (req as string) : req.url
      if (!urlString) return null
      const url = new URL(urlString, 'http://localhost')
      if (
        combinedOpenAPISpec &&
        url.pathname === '/api/openapi.json' &&
        req.method === 'GET'
      ) {
        return new Response(JSON.stringify(combinedOpenAPISpec), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const apiCtx = createApiContext(
        {
          db: userDb,
          env,
          storage,
          email,
          jobs,
          realtime,
          auth,
          authResolver,
        },
        req,
      )

      if (url.pathname.startsWith('/api/rpc')) {
        const res = await rpcHandler.handle(req, {
          prefix: '/api/rpc',
          context: apiCtx,
        })
        if (res.matched) return res.response
      }

      const openapiRes = await openapiHandler.handle(req, { context: apiCtx })
      if (openapiRes.matched) return openapiRes.response

      return null
    }

    const handler = buildHandler({
      authHandler: (req) => auth.handler(req),
      apiHandler,
      rateLimit: options.rateLimit,
    })

    // Topology is a deployment concern: the role decides whether this process
    // runs background work, so application code never has to.
    const roleWantsWorker =
      env.BUNDERSTACK_ROLE === 'all' || env.BUNDERSTACK_ROLE === 'worker'
    const autoStart =
      overrides.backgroundAutoStart === false
        ? false
        : (options.background?.autoStart ??
          (roleWantsWorker && resolvedDefs !== undefined))
    let backgroundRunning = false
    if (autoStart) {
      await startWorker()
      backgroundRunning = true
    }

    const app: BunderstackApp<
      TSchema,
      TAccess,
      BucketNamesOf<TStorage>,
      TEnv,
      JobsDefs | undefined,
      TCustomApiRouter,
      TRealtime
    > = {
      handler,
      // Internal tables live on the runtime db but stay out of the public type.
      db: userDb,
      auth,
      storage,
      env,
      email,
      realtime,
      // Runtime facade is untyped (JobsRuntimeFacade); the generic-typed field
      // narrows `enqueue` per-app from the declared job defs — same relationship
      // as `userDb` above.
      jobs: jobs as never,
      startWorker,
      runWorker,
      close: () => lifecycle.close(),
      backgroundRunning,
      get status() {
        return lifecycle.status
      },
      signal: lifecycle.signal,
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
      adapter: config.database.adapter,
    }

    return app
  } catch (cause) {
    try {
      await lifecycle.close()
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        '[bunderstack] application initialization failed and cleanup failed',
      )
    }
    throw cause
  }
}

export { listSpec } from './api/list-spec'
export type { ListSpecOptions } from './api/list-spec'
export type { BunderstackDb, BunderstackTx } from './db'
export { MAX_LIST_LIMIT } from './list-query'
export { BunderstackError } from './errors'
export type { BunderstackErrorCode } from './errors'
export { resolveConfig, resolveAuthConfig, defineAuth } from './config'
export type {
  AuthConfigContext,
  AuthConfigFactory,
  AuthConfigInput,
  BetterAuthConfig,
  BunderstackConfig,
  ResolvedConfig,
} from './config'
export { validateEnv, createClientEnv, BunderstackEnvError } from './env'
export type { EnvConfigInput, BaseEnv, ValidatedEnv } from './env'
export { buildManifest, parseManifest } from './manifest'
export type { BunderstackManifest, ManifestEnvVar } from './manifest'
export { createEmail } from './email'
export type {
  EmailMessage,
  EmailAdapter,
  EmailConfigInput,
  EmailFacade,
} from './email'
export { createJobsBuilder } from './jobs/index'
export type {
  BunderstackJobContext,
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
export type {
  DatabaseAdapter,
  DatabaseConnection,
  DatabaseConnectionResult,
} from './database/adapter'
export type { StorageAdapter } from './storage/index'
export type {
  StorageConfigInput,
  BucketConfigInput,
  ResolvedBucket,
} from './storage/buckets'
// StorageFacade is declared+exported inline above.
export type { TransformSpec } from './storage/thumbnails'
export type { RealtimeAction } from './realtime/publisher'
export { createRealtimeFacade } from './realtime/facade'
export type {
  RealtimeFacade,
  RealtimeTransport,
  SchemaTable,
} from './realtime/facade'

export { createApiBuilder, defineApi } from './api/builder'
export type { BunderstackApiBuilder, ApiFactory } from './api/builder'
// Needed to declare shared middleware over the app's context, e.g.
// `os.$context<ApiContext<typeof schema>>().middleware(...)`.
export type { ApiContext } from './api/context'
export type {
  CrudApiRouterFor,
  ExposedApiTables,
  MergeApiRouterTypes,
  UnifiedApiRouter,
} from './api/types'
export type { TableCrudProcedures } from './api/crud-router'
export {
  buildApiRegistry,
  mergeApiRoutersStrict,
  normalizeApiPath,
  normalizeForeignOpenAPISpec,
} from './api/registry'
export { mergeOpenAPISpecs } from './api/openapi'
