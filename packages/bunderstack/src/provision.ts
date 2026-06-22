import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ProvisionMode = boolean | 'auto'

export function shouldProvision(
  mode: ProvisionMode | undefined,
  force?: boolean,
): boolean {
  if (force) return true
  const resolved = mode ?? 'auto'
  if (resolved === false) return false
  if (resolved === true) return true
  return process.env.NODE_ENV !== 'production'
}

async function ensureSqliteFileParent(url: string): Promise<void> {
  const match = /^file:(.+)$/.exec(url)
  if (!match) return
  const filePath = match[1]!
  if (filePath === ':memory:') return
  await mkdir(dirname(filePath), { recursive: true })
}

export async function provisionSchema<TSchema extends Record<string, unknown>>(
  db: LibSQLDatabase<TSchema>,
  schema: TSchema,
  options?: { mode?: ProvisionMode; force?: boolean; databaseUrl?: string },
): Promise<void> {
  if (!shouldProvision(options?.mode, options?.force)) return

  if (options?.databaseUrl) {
    await ensureSqliteFileParent(options.databaseUrl)
  }

  const { pushSQLiteSchema } = await import('drizzle-kit/api')
  const result = await pushSQLiteSchema(schema, db)

  if (
    result.hasDataLoss &&
    !options?.force &&
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error(
      '[bunderstack] Schema push would cause data loss. Run `bunx drizzle-kit push` or call app.provision({ force: true }).',
    )
  }

  if (result.warnings.length > 0 && process.env.NODE_ENV !== 'production') {
    for (const warning of result.warnings) {
      console.warn(`[bunderstack] ${warning}`)
    }
  }

  if (result.statementsToExecute.length === 0) return

  await result.apply()

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[bunderstack] provisioned ${result.statementsToExecute.length} schema change(s)`,
    )
  }
}
