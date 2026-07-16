// src/dialect.ts — schema-driven dialect detection. Imports only dialect-core
// drizzle entrypoints (no drivers), safe in every module graph.
import { is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'

export type Dialect = 'sqlite' | 'pg'

/**
 * Minimal structural view of a drizzle db shared by both dialects. Internal
 * modules run dynamic tables (Record<string, unknown> schemas) where drizzle's
 * generics add no safety, so they accept this instead of a per-dialect union.
 * The public surface (`app.db`, tRPC ctx) keeps full per-dialect typing via
 * `DbFor` in db.ts.
 */
export type AnyDb = {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
  delete: (...args: any[]) => any
}

/** Classify a schema by its table brands. Mixed dialects are a config error. */
export function detectDialect(schema: Record<string, unknown>): Dialect {
  let pgKey: string | undefined
  let sqliteKey: string | undefined
  for (const [key, value] of Object.entries(schema)) {
    if (is(value, PgTable)) pgKey ??= key
    else if (is(value, SQLiteTable)) sqliteKey ??= key
  }
  if (pgKey !== undefined && sqliteKey !== undefined) {
    throw new Error(
      `[bunderstack] schema mixes dialects: "${pgKey}" is a Postgres table while "${sqliteKey}" is a SQLite table. ` +
        'Define every table with the same dialect (drizzle-orm/pg-core or drizzle-orm/sqlite-core).',
    )
  }
  return pgKey !== undefined ? 'pg' : 'sqlite'
}
