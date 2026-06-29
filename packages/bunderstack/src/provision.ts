import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

async function ensureSqliteFileParent(url: string): Promise<void> {
  const match = /^file:(.+)$/.exec(url)
  if (!match) return
  const filePath = match[1]!
  if (filePath === ':memory:') return
  await mkdir(dirname(filePath), { recursive: true })
}

/** Push the merged schema to the database via drizzle-kit/api. */
export async function provisionSchema<TSchema extends Record<string, unknown>>(
  db: LibSQLDatabase<TSchema>,
  schema: TSchema,
  options?: { force?: boolean; databaseUrl?: string },
): Promise<void> {
  if (options?.databaseUrl) {
    await ensureSqliteFileParent(options.databaseUrl)
  }

  const { pushSQLiteSchema } = await import('drizzle-kit/api')
  const result = await pushSQLiteSchema(schema, db)

  if (result.hasDataLoss && !options?.force) {
    throw new Error(
      '[bunderstack] Schema push would cause data loss. Run `bunx drizzle-kit push` or call app.provision({ force: true }).',
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
