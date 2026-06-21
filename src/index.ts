// src/index.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Hono } from 'hono'
import { resolveConfig, type BunderstackConfig } from './config'
import { createDb } from './db'
import { buildCrudRouter } from './crud'
import { buildHandler } from './handler'

// Auth and storage stubs — replaced in Tasks 6 and 7
type AuthStub = { handler: (req: Request) => Promise<Response> }
type StorageStub = object

export type BunderstackApp<TSchema extends Record<string, unknown>> = {
  handler: (req: Request) => Promise<Response>
  db: LibSQLDatabase<TSchema>
  auth: AuthStub
  storage: StorageStub
  router: Hono
}

export function createBunderstack<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
): BunderstackApp<TSchema> {
  const config = resolveConfig(options)
  const db = createDb(options.schema, config.database)
  const crudRouter = buildCrudRouter(options.schema, db)
  const { handler, router } = buildHandler({ crudRouter })

  return {
    handler,
    db,
    auth: { handler: async () => new Response('auth not configured', { status: 501 }) },
    storage: {},
    router,
  }
}

export { resolveConfig } from './config'
export type { BunderstackConfig, ResolvedConfig } from './config'
