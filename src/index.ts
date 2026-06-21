// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono as HonoType } from 'hono'
import { resolveConfig, type BunderstackConfig } from './config'
import { createDb } from './db'
import { buildCrudRouter } from './crud'
import { createAuth } from './auth'
import { createStorage, type StorageAdapter } from './storage/index'
import { buildHandler } from './handler'
import { validateUpload, type UploadRules } from './storage/validation'
import { transformImage, parseTransformSpec, transformHash } from './storage/thumbnails'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

type AuthInstance = ReturnType<typeof createAuth>

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthInstance
  storage: StorageAdapter
  router: HonoType
}

export interface BunderstackStorageConfig {
  uploadRules?: UploadRules
}

function buildStorageRouter(storage: StorageAdapter, opts: BunderstackStorageConfig = {}): Hono {
  const router = new Hono()

  router.post('/', async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) return c.json({ error: 'No file field in request' }, 400)

    if (opts.uploadRules) {
      try {
        validateUpload(file, opts.uploadRules)
      } catch (err) {
        return c.json({ error: (err as Error).message }, 422)
      }
    }

    const ext = extname(file.name) || ''
    const fileId = `${randomUUID()}${ext}`
    await storage.upload(fileId, await file.arrayBuffer(), file.type)
    return c.json({ fileId, url: `/files/${fileId}` }, 201)
  })

  router.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    const query = c.req.query() as Record<string, string>
    const spec = parseTransformSpec(query)

    if (spec) {
      const ext = spec.format ? `.${spec.format}` : (extname(fileId) || '.jpg')
      const cacheKey = `${fileId}__${transformHash(spec)}${ext}`
      const cachedExists = await storage.exists(cacheKey)
      if (cachedExists) return storage.get(cacheKey)

      const original = await storage.get(fileId)
      if (original.status === 404) return original

      const inputBuffer = Buffer.from(await original.clone().arrayBuffer())
      const transformed = await transformImage(inputBuffer, spec)
      const contentType = spec.format ? `image/${spec.format}` : original.headers.get('Content-Type') ?? 'image/jpeg'
      await storage.upload(cacheKey, transformed, contentType)
      return new Response(transformed, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' } })
    }

    return storage.get(fileId)
  })

  router.delete('/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    await storage.delete(fileId)
    return new Response(null, { status: 204 })
  })

  return router
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema> & { storageOptions?: BunderstackStorageConfig },
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const db = createDb(options.schema, config.database)
  const auth = createAuth(db as LibSQLDatabase<Record<string, unknown>>, config.auth)
  const storage = createStorage(config.storage)
  const crudRouter = buildCrudRouter(options.schema, db)
  const storageRouter = buildStorageRouter(storage, options.storageOptions)
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
    storageRouter,
  })

  return { handler, db, auth, storage, router }
}

export { resolveConfig } from './config'
export type { BunderstackConfig, ResolvedConfig } from './config'
export type { StorageAdapter } from './storage/index'
export type { UploadRules } from './storage/validation'
export type { TransformSpec } from './storage/thumbnails'
