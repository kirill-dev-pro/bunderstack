// src/db.ts — dialect/driver dispatch. Every driver module loads via dynamic
// import so the driver packages stay optional peers; the ignore comments keep
// bundlers (vite/nitro, webpack) from resolving them at build time.
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { PgDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core'

import { mkdir } from 'node:fs/promises'

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

async function importDriver<T>(specifier: string, hint: string): Promise<T> {
  try {
    return (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ specifier
    )) as T
  } catch (cause) {
    throw new Error(`[bunderstack] ${hint}`, { cause })
  }
}

export async function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  cfg: { url: string; authToken?: string; dialect: Dialect },
): Promise<{ db: DbFor<TSchema>; driver: Driver }> {
  if (cfg.dialect === 'sqlite') {
    if (PG_SERVER_RE.test(cfg.url)) {
      throw new Error(
        '[bunderstack] DATABASE_URL is a Postgres URL but the schema uses sqliteTable. ' +
          'Define the schema with drizzle-orm/pg-core, or point DATABASE_URL at a SQLite database.',
      )
    }
    const { drizzle } = await importDriver<typeof import('drizzle-orm/libsql')>(
      'drizzle-orm/libsql',
      'SQLite support requires @libsql/client, which is not installed.\n' +
        '  Run `bun add @libsql/client`.',
    )
    const db = drizzle({
      connection: { url: cfg.url, authToken: cfg.authToken },
      schema,
    })
    return { db: db as unknown as DbFor<TSchema>, driver: 'libsql' }
  }

  if (LIBSQL_REMOTE_RE.test(cfg.url)) {
    throw new Error(
      '[bunderstack] DATABASE_URL looks like a libsql/Turso URL but the schema uses pgTable. ' +
        'Set DATABASE_URL=postgres://… (or leave it unset for local PGlite).',
    )
  }

  if (PG_SERVER_RE.test(cfg.url)) {
    if (typeof Bun !== 'undefined') {
      const { drizzle } = await import(
        /* @vite-ignore */ /* webpackIgnore: true */ 'drizzle-orm/bun-sql'
      )
      return {
        db: drizzle(cfg.url, { schema }) as unknown as DbFor<TSchema>,
        driver: 'bun-sql',
      }
    }
    const { drizzle } = await importDriver<
      typeof import('drizzle-orm/postgres-js')
    >(
      'drizzle-orm/postgres-js',
      'Postgres on Node requires the `postgres` driver, which is not installed.\n' +
        '  Run `npm install postgres`. (Under Bun the built-in Bun.sql is used instead.)',
    )
    return {
      db: drizzle(cfg.url, { schema }) as unknown as DbFor<TSchema>,
      driver: 'postgres-js',
    }
  }

  // Local PGlite: `file:<dir>`, a bare path, `:memory:`, or `memory://`.
  const raw = cfg.url.startsWith('file:') ? cfg.url.slice('file:'.length) : cfg.url
  const dataDir = raw === ':memory:' ? 'memory://' : raw
  if (!dataDir.startsWith('memory://')) {
    await mkdir(dataDir, { recursive: true })
  }
  const { drizzle } = await importDriver<typeof import('drizzle-orm/pglite')>(
    'drizzle-orm/pglite',
    'Local Postgres development requires PGlite, which is not installed.\n' +
      '  Run `bun add -d @electric-sql/pglite` — bunderstack runs an embedded Postgres in ./data.pglite.\n' +
      '  In production set DATABASE_URL=postgres://… (PGlite is not needed there).',
  )
  return {
    db: drizzle(dataDir, { schema }) as unknown as DbFor<TSchema>,
    driver: 'pglite',
  }
}
