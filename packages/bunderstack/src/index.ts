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
/** How often the auto-started orphan sweep runs. */
const SWEEP_INTERVAL_MS = 10 * 60_000

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
   * automatically on an interval; exposed for manual/test invocation. Returns
   * the count reaped.
   */
  sweep(olderThanMs?: number): Promise<number>
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
  TRouter = undefined,
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
// inference (which breaks under contextual return types).
export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TRouter extends AnyRouter = AnyRouter,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    /** Builder callback receiving the pre-wired `t` instance. */
    trpc: (t: BunderstackTRPC<TSchema, ValidatedEnv<TEnv>>) => TRouter
  },
): Promise<BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, TRouter>>
export function createBunderstack<
  TSchema extends Record<string, unknown>,
  const TAccess extends Record<string, TableAccessInput> | undefined =
    undefined,
  const TStorage extends StorageConfigInput | undefined = undefined,
  const TEnv extends EnvConfigInput | undefined = undefined,
  TRouter extends AnyRouter | undefined = undefined,
>(
  options: BunderstackConfig<TSchema, TAccess, TStorage, TEnv> & {
    /** Prebuilt tRPC router (escape hatch for multi-file setups). */
    trpc?: TRouter
  },
): Promise<BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, TRouter>>
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
  },
): Promise<
  BunderstackApp<TSchema, TAccess, BucketNamesOf<TStorage>, TEnv, AnyRouter | undefined>
> {
  const dialect = detectDialect(options.schema)
  // Env is validated FIRST: the app refuses to boot on missing/invalid vars,
  // and everything downstream (config, email, trpc ctx) consumes the result.
  const env = validateEnv(options.env, {
    emailProvider: emailProviderTag(options.email),
    defaultDatabaseUrl:
      dialect === 'pg' ? 'file:./data.pglite' : 'file:./data.db',
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
  // Auto-reap orphaned `pending` uploads. `unref()` keeps this from holding the
  // process (and test runners) open.
  const sweepTimer = setInterval(() => {
    void sweepOrphans(registry, db, DEFAULT_PENDING_TTL_MS).catch(() => {})
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
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
            req,
          }),
        })
    : undefined
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
    storageRouter,
    realtimeRouter,
    trpcHandler,
    rateLimit: options.rateLimit,
  })

  const app: BunderstackApp<
    TSchema,
    TAccess,
    BucketNamesOf<TStorage>,
    TEnv,
    AnyRouter | undefined
  > = {
    handler,
    // Internal tables live on the runtime db but stay out of the public type.
    db: userDb,
    auth,
    storage,
    router,
    env,
    email,
    trpcRouter,
    manifest: buildManifest({
      schema: options.schema,
      dialect,
      storage: config.storage,
      envConfig: options.env as EnvConfigInput | undefined,
      realtime: Boolean(config.realtime),
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
