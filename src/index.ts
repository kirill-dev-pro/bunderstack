// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono } from 'hono'
import { resolveConfig, type BunderstackConfig } from './config'
import { createDb } from './db'
import { buildCrudRouter } from './crud'
import { createAuth } from './auth'
import { buildHandler } from './handler'

type AuthInstance = ReturnType<typeof createAuth>
type StorageStub = object

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthInstance
  storage: StorageStub
  router: Hono
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const db = createDb(options.schema, config.database)
  const auth = createAuth(db as LibSQLDatabase<Record<string, unknown>>, config.auth)
  const crudRouter = buildCrudRouter(options.schema, db)
  const { handler, router } = buildHandler({
    crudRouter,
    authHandler: (req) => auth.handler(req),
  })

  return { handler, db, auth, storage: {}, router }
}

export { resolveConfig } from './config'
export type { BunderstackConfig, ResolvedConfig } from './config'
