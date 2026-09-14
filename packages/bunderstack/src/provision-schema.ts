import type { AnyDb } from './dialect'

import { detectDialect } from './dialect'
import {
  applyCommittedMigrations,
  ensureLocalDataDir,
  getProvisionInternals,
} from './provision-runtime'

const DRIZZLE_KIT_HINT =
  '[bunderstack] Schema push requires drizzle-kit, which is not installed.\n' +
  '  Development: run `bun add -d drizzle-kit` and import provision from `bunderstack/provision-schema`.\n' +
  '  Production: generate migrations with `bunx drizzle-kit generate`, commit them, and use `bunderstack/provision`.'

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
    kit = await import('drizzle-kit/api')
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
  for (const warning of result.warnings) {
    console.warn(`[bunderstack] ${warning}`)
  }
  if (result.statementsToExecute.length === 0) return

  await result.apply()
  console.log(
    `[bunderstack] provisioned ${result.statementsToExecute.length} schema change(s)`,
  )
}

/**
 * Development provisioning: apply committed migrations when present,
 * otherwise push the current schema through Drizzle Kit.
 */
export async function provision(
  app: object,
  options?: { force?: boolean },
): Promise<void> {
  if (await applyCommittedMigrations(app)) return
  const internals = getProvisionInternals(app)
  await provisionSchema(internals.db, internals.schema, {
    force: options?.force,
    databaseUrl: internals.databaseUrl,
  })
}

export type TestSchemaMode = 'auto' | 'push' | 'migrations'

export async function provisionForTest(
  app: object,
  mode: TestSchemaMode,
): Promise<void> {
  if (mode === 'auto') {
    await provision(app, { force: true })
    return
  }

  const internals = getProvisionInternals(app)
  if (mode === 'push') {
    await provisionSchema(internals.db, internals.schema, {
      force: true,
      databaseUrl: internals.databaseUrl,
    })
    return
  }

  if (!(await applyCommittedMigrations(app))) {
    throw new Error('[bunderstack] committed migrations journal not found')
  }
}
