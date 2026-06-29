// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono as HonoType } from 'hono'

import type { StorageAdapter } from './storage/index.ts'

import { validateAndResolveAccess } from './access.ts'
import { createAuth, toAuthSessionResolver } from './auth.ts'
import { resolveConfig, type BunderstackConfig } from './config.ts'
import { resolveRealtimeRedisUrl } from './config.ts'
import { buildCrudRouter } from './crud.ts'
import { createDb } from './db.ts'
import { buildHandler } from './handler.ts'
import { withInternalTables } from './internal-tables.ts'
import { provisionSchema, type ProvisionMode } from './provision.ts'
import { createRedisRealtimeBroker } from './realtime/redis.ts'
import { createRealtimeBroker, buildRealtimeRouter } from './realtime/index.ts'
import { deleteFileWithDerivatives } from './storage/delete.ts'
import { deleteFileMetaRow } from './storage/file-meta.ts'
import { createBucketStorages } from './storage/registry.ts'
import { buildBucketStorageRouter } from './storage/router.ts'
import { sweepOrphans } from './storage/sweep.ts'

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

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthInstance
  storage: StorageFacade
  router: HonoType
  /** Push Drizzle schema to the database. Auto-runs in dev when `provision: 'auto'` (default). */
  provision: (options?: { force?: boolean }) => Promise<void>
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const provisionMode: ProvisionMode = options.provision ?? 'auto'
  // Merge bunderstack's internal tables (file-meta, idempotency) into the
  // schema used for the db client + provisioning. CRUD/access stay on the USER
  // schema so internal tables never get a CRUD route.
  const mergedSchema = withInternalTables(options.schema)
  const db = createDb(mergedSchema, config.database)
  // `db` is typed with the merged schema (user tables + internal tables) so the
  // storage/idempotency code can query the internal tables. The public surface
  // and CRUD only expose the USER schema. TS can widen `LibSQLDatabase<merged>`
  // to `LibSQLDatabase<Record<string, unknown>>` on its own (storage/auth pass
  // `db` directly), but it can't *narrow* a generic schema view, so this single
  // intentional cast produces the user-facing db type. See `app.db` / crud below.
  const userDb = db as unknown as LibSQLDatabase<TSchema>
  const auth = createAuth(db, config.auth)
  // Internal routers consume the narrow AuthSessionResolver contract, not the
  // raw better-auth instance. app.auth still exposes `auth` unchanged.
  const authResolver = toAuthSessionResolver(auth)
  const resolvedAccess = validateAndResolveAccess(
    options.schema,
    options.access,
  )
  const realtimeBufferSize =
    typeof config.realtime === 'object' ? config.realtime.bufferSize : undefined
  const redisUrl = config.realtime
    ? resolveRealtimeRedisUrl(config.realtime)
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
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
    storageRouter,
    realtimeRouter,
    rateLimit: options.rateLimit,
  })

  const app: BunderstackApp<TSchema> = {
    handler,
    // Internal tables live on the runtime db but stay out of the public type.
    db: userDb,
    auth,
    storage,
    router,
    provision: (opts) =>
      provisionSchema(db, mergedSchema, {
        mode: provisionMode,
        force: opts?.force,
        databaseUrl: config.database.url,
      }),
  }

  return app
}

/** Create Bunderstack and auto-provision the database schema (dev by default). */
export async function createBunderstackAsync<
  TSchema extends Record<string, unknown>,
>(options: BunderstackConfig<TSchema>): Promise<BunderstackApp<TSchema>> {
  const app = createBunderstack(options)
  await app.provision()
  return app
}

export { resolveConfig } from './config.ts'
export type {
  BetterAuthConfig,
  BunderstackConfig,
  ResolvedConfig,
} from './config.ts'
export { provisionSchema, shouldProvision } from './provision.ts'
export type { ProvisionMode } from './provision.ts'
export {
  defineAccess,
  validateAndResolveAccess,
  checkAccess,
  AUTH_TABLE_NAMES,
} from './access.ts'
export type {
  TableAccessInput,
  OperationRule,
  AccessContext,
  AccessUser,
} from './access.ts'
export {
  typeid,
  generate as generateTypeId,
  parse as parseTypeId,
  asTypeId,
} from './typeid.ts'
export type { TypeId } from './typeid.ts'
export type { StorageAdapter } from './storage/index.ts'
export type {
  StorageConfigInput,
  BucketConfigInput,
  ResolvedBucket,
} from './storage/buckets.ts'
// StorageFacade is declared+exported inline above.
export type { TransformSpec } from './storage/thumbnails.ts'

// Re-export drizzle builders so consumers share bunderstack's drizzle-orm instance
// and avoid type incompatibilities from duplicate installs.
export {
  sqliteTable,
  integer,
  text,
  real,
  blob,
  numeric,
  foreignKey,
} from 'drizzle-orm/sqlite-core'
export { eq, and, or, not, gt, gte, lt, lte, desc, asc, sql } from 'drizzle-orm'
