// src/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { ResolvedConfig } from './config'

export function createAuth(
  db: LibSQLDatabase<Record<string, unknown>>,
  cfg: ResolvedConfig['auth'],
) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    emailAndPassword: { enabled: cfg.emailPassword },
    secret: cfg.secret,
    socialProviders: {
      ...(cfg.providers.github && {
        github: { clientId: cfg.providers.github.clientId, clientSecret: cfg.providers.github.clientSecret },
      }),
      ...(cfg.providers.google && {
        google: { clientId: cfg.providers.google.clientId, clientSecret: cfg.providers.google.clientSecret },
      }),
    },
  })
}
