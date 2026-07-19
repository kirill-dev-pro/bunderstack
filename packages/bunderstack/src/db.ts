import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { PgDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core'

import type { DatabaseAdapter, DatabaseConnection } from './database/adapter'
import type { Dialect } from './dialect'

export type Driver = 'libsql' | 'pglite' | 'bun-sql' | 'postgres-js'

/** Per-dialect public db type, computed from the schema's table brands. */
export type DbFor<TSchema extends Record<string, unknown>> = [
  Extract<TSchema[keyof TSchema], PgTable>,
] extends [never]
  ? LibSQLDatabase<TSchema>
  : PgDatabase<PgQueryResultHKT, TSchema>

const PG_SERVER_RE = /^postgres(ql)?:\/\//
const LIBSQL_REMOTE_RE = /^(libsql|wss?|https?):\/\//

export function validateDatabaseUrl(url: string, dialect: Dialect) {
  if (dialect === 'sqlite') {
    if (PG_SERVER_RE.test(url)) {
      throw new Error(
        '[bunderstack] DATABASE_URL is a Postgres URL but the schema uses sqliteTable. ' +
          'Define the schema with drizzle-orm/pg-core, or point DATABASE_URL at a SQLite database.',
      )
    }
  } else if (dialect === 'pg') {
    if (LIBSQL_REMOTE_RE.test(url)) {
      throw new Error(
        '[bunderstack] DATABASE_URL looks like a libsql/Turso URL but the schema uses pgTable. ' +
          'Set DATABASE_URL=postgres://… (or leave it unset for local PGlite).',
      )
    }
  }
}

export async function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: DatabaseConnection & { adapter: DatabaseAdapter; dialect: Dialect },
): Promise<{ db: DbFor<TSchema>; driver: Driver }> {
  if (cfg.adapter.dialect !== cfg.dialect) {
    throw new Error(
      `[bunderstack] database adapter dialect ${cfg.adapter.dialect} does not match ${cfg.dialect} schema`,
    )
  }
  validateDatabaseUrl(cfg.url, cfg.dialect)
  const db = await cfg.adapter.connect(schema, {
    url: cfg.url,
    authToken: cfg.authToken,
  })
  return { db, driver: cfg.adapter.driver }
}
