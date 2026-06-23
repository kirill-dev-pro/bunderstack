import type { LibSQLDatabase } from 'drizzle-orm/libsql'

// src/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import type { BetterAuthConfig } from './config.ts'

export function createAuth(
  db: LibSQLDatabase<Record<string, unknown>>,
  cfg: BetterAuthConfig,
) {
  return betterAuth({
    ...cfg,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
  })
}
