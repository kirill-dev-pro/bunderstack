// src/provision.ts
import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AnyDb, Dialect } from './dialect'

import { detectDialect } from './dialect'
import {
  PROVISION_INTERNALS,
  type WithProvisionInternals,
} from './provision-internals'

/** Create the local backing directory for file-based urls, per dialect. */
async function ensureLocalDataDir(url: string, dialect: Dialect): Promise<void> {
  if (dialect === 'pg') {
    // PGlite data dir: `file:<dir>` or a bare path; server/memory urls need nothing.
    if (/^postgres(ql)?:\/\//.test(url)) return
    const raw = url.startsWith('file:') ? url.slice('file:'.length) : url
    if (raw === ':memory:' || raw.startsWith('memory://')) return
    await mkdir(raw, { recursive: true })
    return
  }
  const match = /^file:(.+)$/.exec(url)
  if (!match) return
  const filePath = match[1]!
  if (filePath === ':memory:') return
  await mkdir(dirname(filePath), { recursive: true })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const DRIZZLE_KIT_HINT =
  '[bunderstack] Schema push requires drizzle-kit, which is not installed.\n' +
  '  Development: run `bun add -d drizzle-kit` — provision() will push schema changes to the database on startup.\n' +
  '  Production: generate migrations locally with `bunx drizzle-kit generate` and commit the folder — provision() applies them without drizzle-kit.'

/** Push the merged schema to the database via drizzle-kit/api. */
export async function provisionSchema<TSchema extends Record<string, unknown>>(
  db: AnyDb,
  schema: TSchema,
  options?: { force?: boolean; databaseUrl?: string },
): Promise<void> {
  const dialect = detectDialect(schema)
  if (options?.databaseUrl) {
    await ensureLocalDataDir(options.databaseUrl, dialect)
  }

  let kit: typeof import('drizzle-kit/api')
  try {
    // Ignore comments keep bundlers (vite/nitro, webpack) from resolving
    // drizzle-kit at build time — this branch only runs in development.
    kit = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ 'drizzle-kit/api'
    )
  } catch (cause) {
    throw new Error(DRIZZLE_KIT_HINT, { cause })
  }

  const result =
    dialect === 'pg'
      ? await kit.pushSchema(schema, db as never)
      : await kit.pushSQLiteSchema(schema, db as never)

  if (result.hasDataLoss && !options?.force) {
    throw new Error(
      '[bunderstack] Schema push would cause data loss. Run `bunx drizzle-kit push` or call provision(app, { force: true }).',
    )
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[bunderstack] ${warning}`)
    }
  }

  if (result.statementsToExecute.length === 0) return

  await result.apply()

  console.log(
    `[bunderstack] provisioned ${result.statementsToExecute.length} schema change(s)`,
  )
}

const MIGRATOR_MODULES = {
  libsql: 'drizzle-orm/libsql/migrator',
  pglite: 'drizzle-orm/pglite/migrator',
  'bun-sql': 'drizzle-orm/bun-sql/migrator',
  'postgres-js': 'drizzle-orm/postgres-js/migrator',
} as const

/**
 * Provision the database for a Bunderstack app.
 *
 * The migrations folder is the mode switch:
 * - `<migrations>/meta/_journal.json` exists → apply committed migrations via
 *   drizzle-orm's migrator. Pure runtime; drizzle-kit is never imported, so a
 *   fresh clone deploys with `bun install --production`.
 * - No migrations → development: push the schema straight to the database via
 *   drizzle-kit (install it with `bun add -d drizzle-kit`).
 *
 * Once you run `bunx drizzle-kit generate` for the first time, provision stops
 * pushing and every schema change goes through an explicit `generate`.
 */
export async function provision(
  app: object,
  options?: { force?: boolean },
): Promise<void> {
  const internals = (app as WithProvisionInternals)[PROVISION_INTERNALS]
  if (!internals) {
    throw new Error(
      '[bunderstack] provision() expects the app returned by createBunderstack().',
    )
  }

  const { db, schema, databaseUrl, migrationsFolder, dialect, driver } =
    internals
  const journal = join(migrationsFolder, 'meta', '_journal.json')

  if (await exists(journal)) {
    await ensureLocalDataDir(databaseUrl, dialect)
    const { migrate } = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ MIGRATOR_MODULES[driver]
    )) as { migrate: (db: never, cfg: { migrationsFolder: string }) => Promise<void> }
    await migrate(db as never, { migrationsFolder })
    return
  }

  await provisionSchema(db, schema, { force: options?.force, databaseUrl })
}
