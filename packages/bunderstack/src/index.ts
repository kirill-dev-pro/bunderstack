// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono as HonoType } from 'hono'

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

import { validateAndResolveAccess, resolveAccessUser } from './access.ts'
import { createAuth } from './auth.ts'
import { resolveConfig, type BunderstackConfig } from './config.ts'
import { buildCrudRouter } from './crud.ts'
import { createDb } from './db.ts'
import { ErrorCode, apiError } from './errors.ts'
import {
  checkFileAccess,
  DEFAULT_STORAGE_ACCESS,
  deleteFileMeta,
  getFileOwner,
  setFileOwner,
  type StorageAccessConfig,
} from './file-metadata.ts'
import { buildHandler } from './handler.ts'
import { createRealtimeBroker, buildRealtimeRouter } from './realtime.ts'
import { provisionSchema, type ProvisionMode } from './provision.ts'
import { createStorage, type StorageAdapter } from './storage/index.ts'
import {
  transformImage,
  parseTransformSpec,
  transformHash,
} from './storage/thumbnails.ts'
import { validateUpload, type UploadRules } from './storage/validation.ts'

type AuthInstance = ReturnType<typeof createAuth>

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthInstance
  storage: StorageAdapter
  router: HonoType
  /** Push Drizzle schema to the database. Auto-runs in dev when `provision: 'auto'` (default). */
  provision: (options?: { force?: boolean }) => Promise<void>
}

export interface BunderstackStorageConfig {
  uploadRules?: UploadRules
  access?: StorageAccessConfig
}

function buildStorageRouter(
  storage: StorageAdapter,
  db: LibSQLDatabase<Record<string, unknown>>,
  auth: AuthInstance | undefined,
  opts: BunderstackStorageConfig = {},
): Hono {
  const router = new Hono()
  const access = { ...DEFAULT_STORAGE_ACCESS, ...opts.access }

  router.post('/', async (c) => {
    const user = await resolveAccessUser(auth, c.req.raw.headers)
    const denied = await checkFileAccess(access.create, null, user?.id ?? null)
    if (!denied.allowed) {
      return apiError(
        c,
        ErrorCode.FORBIDDEN,
        'Forbidden',
        denied.status === 401 ? 401 : 403,
      )
    }

    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) {
      return apiError(
        c,
        ErrorCode.VALIDATION_ERROR,
        'No file field in request',
        400,
      )
    }

    if (opts.uploadRules) {
      try {
        validateUpload(file, opts.uploadRules)
      } catch (err) {
        return apiError(
          c,
          ErrorCode.VALIDATION_ERROR,
          (err as Error).message,
          422,
        )
      }
    }

    const ext = extname(file.name) || ''
    const fileId = `${randomUUID()}${ext}`
    await storage.upload(fileId, await file.arrayBuffer(), file.type)
    await setFileOwner(db, fileId, user?.id ?? null)
    return c.json({ fileId, url: `/api/files/${fileId}` }, 201)
  })

  router.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    const user = await resolveAccessUser(auth, c.req.raw.headers)
    const ownerId = await getFileOwner(db, fileId)
    const denied = await checkFileAccess(access.get, ownerId, user?.id ?? null)
    if (!denied.allowed) {
      return apiError(
        c,
        ErrorCode.FORBIDDEN,
        'Forbidden',
        denied.status === 401 ? 401 : 403,
      )
    }

    const query = c.req.query() as Record<string, string>
    const spec = parseTransformSpec(query)

    if (spec) {
      const ext = spec.format ? `.${spec.format}` : extname(fileId) || '.jpg'
      const cacheKey = `${fileId}__${transformHash(spec)}${ext}`
      const cachedExists = await storage.exists(cacheKey)
      if (cachedExists) return storage.get(cacheKey)

      const original = await storage.get(fileId)
      if (original.status === 404) return original

      const inputBuffer = Buffer.from(await original.clone().arrayBuffer())
      const transformed = await transformImage(inputBuffer, spec)
      const contentType = spec.format
        ? `image/${spec.format}`
        : (original.headers.get('Content-Type') ?? 'image/jpeg')
      const transformedAb = transformed.buffer.slice(
        transformed.byteOffset,
        transformed.byteOffset + transformed.byteLength,
      ) as ArrayBuffer
      await storage.upload(cacheKey, transformedAb, contentType)
      return new Response(transformedAb, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000',
        },
      })
    }

    return storage.get(fileId)
  })

  router.delete('/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    const user = await resolveAccessUser(auth, c.req.raw.headers)
    const ownerId = await getFileOwner(db, fileId)
    const denied = await checkFileAccess(
      access.delete,
      ownerId,
      user?.id ?? null,
    )
    if (!denied.allowed) {
      return apiError(
        c,
        ErrorCode.FORBIDDEN,
        'Forbidden',
        denied.status === 401 ? 401 : 403,
      )
    }

    await storage.delete(fileId)
    await deleteFileMeta(db, fileId)
    return new Response(null, { status: 204 })
  })

  return router
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema> & {
    storageOptions?: BunderstackStorageConfig
  },
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const provisionMode: ProvisionMode = options.provision ?? 'auto'
  const db = createDb(options.schema, config.database)
  const auth = createAuth(
    db as LibSQLDatabase<Record<string, unknown>>,
    config.auth,
  )
  const storage = createStorage(config.storage)
  const resolvedAccess = validateAndResolveAccess(
    options.schema,
    options.access,
  )
  const broker = config.realtime
    ? createRealtimeBroker({
        access: resolvedAccess,
        bufferSize:
          typeof config.realtime === 'object' ? config.realtime.bufferSize : undefined,
      })
    : undefined
  const crudRouter = buildCrudRouter(options.schema, db, {
    auth,
    access: resolvedAccess,
    idempotency: options.idempotency,
    broker,
  })
  const realtimeRouter = broker
    ? buildRealtimeRouter(broker, {
        auth,
        keepaliveMs:
          typeof config.realtime === 'object' ? config.realtime.keepaliveMs : undefined,
      })
    : undefined
  const storageRouter = buildStorageRouter(
    storage,
    db as LibSQLDatabase<Record<string, unknown>>,
    auth,
    options.storageOptions,
  )
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
    storageRouter,
    realtimeRouter,
    rateLimit: options.rateLimit,
  })

  const app: BunderstackApp<TSchema> = {
    handler,
    db,
    auth,
    storage,
    router,
    provision: (opts) =>
      provisionSchema(db, options.schema, {
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
>(
  options: BunderstackConfig<TSchema> & {
    storageOptions?: BunderstackStorageConfig
  },
): Promise<BunderstackApp<TSchema>> {
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
export type { StorageAccessConfig } from './file-metadata.ts'
export type { StorageAdapter } from './storage/index.ts'
export type { UploadRules } from './storage/validation.ts'
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
