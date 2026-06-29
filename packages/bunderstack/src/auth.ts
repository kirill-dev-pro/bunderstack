import type { LibSQLDatabase } from 'drizzle-orm/libsql'

// src/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import type { BetterAuthConfig } from './config.ts'
import type { AuthSessionResolver } from './access.ts'

export function createAuth(
  db: LibSQLDatabase<Record<string, unknown>>,
  cfg: BetterAuthConfig,
) {
  return betterAuth({
    ...cfg,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
  })
}

/**
 * Adapt the raw better-auth instance to our internal {@link AuthSessionResolver}
 * contract. better-auth's `getSession` has a union return (a bare session, or a
 * `{ headers, response }` wrapper when `returnHeaders` is set); we only ever
 * call the bare form, so we narrow on `'user' in result` and map to our shape.
 * Keeping this adapter here means internal modules never depend on better-auth's
 * evolving types.
 */
export function toAuthSessionResolver(
  auth: ReturnType<typeof createAuth>,
): AuthSessionResolver {
  return {
    api: {
      async getSession({ headers }) {
        const result = await auth.api.getSession({ headers })
        if (result && 'user' in result && result.user) {
          const session = 'session' in result ? result.session : null
          return {
            user: {
              id: result.user.id,
              email: result.user.email,
              name: result.user.name,
            },
            session: session
              ? {
                  activeOrganizationId:
                    (session as { activeOrganizationId?: string | null })
                      .activeOrganizationId ?? null,
                }
              : null,
          }
        }
        return null
      },
    },
  }
}
