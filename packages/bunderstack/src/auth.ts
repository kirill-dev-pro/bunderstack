import type { LibSQLDatabase } from 'drizzle-orm/libsql'

// src/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import type { BetterAuthConfig } from './config'
import type { AuthSessionResolver } from './access'
import type { EmailFacade } from './email'

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
          const activeOrganizationId =
            session &&
            'activeOrganizationId' in session &&
            typeof session.activeOrganizationId === 'string'
              ? session.activeOrganizationId
              : null
          return {
            user: {
              id: result.user.id,
              email: result.user.email,
              name: result.user.name,
            },
            session: session
              ? { activeOrganizationId }
              : null,
          }
        }
        return null
      },
    },
  }
}

/**
 * Fill better-auth's email hooks from the bunderstack email facade. Only fills
 * gaps: user-supplied handlers always win, and nothing is injected when email
 * isn't configured. emailAndPassword is only touched when the user enabled it
 * (injecting it unasked would enable the feature).
 */
export function withEmailAuthDefaults(
  cfg: BetterAuthConfig,
  email: EmailFacade,
  emailConfigured: boolean,
): BetterAuthConfig {
  if (!emailConfigured) return cfg
  const out: BetterAuthConfig = { ...cfg }

  if (cfg.emailAndPassword?.enabled && !cfg.emailAndPassword.sendResetPassword) {
    out.emailAndPassword = {
      ...cfg.emailAndPassword,
      sendResetPassword: async ({ user, url }) => {
        await email.send({
          to: user.email,
          subject: 'Reset your password',
          text: `Click the link to reset your password:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        })
      },
    }
  }

  if (!cfg.emailVerification?.sendVerificationEmail) {
    out.emailVerification = {
      ...cfg.emailVerification,
      sendVerificationEmail: async ({ user, url }) => {
        await email.send({
          to: user.email,
          subject: 'Verify your email',
          text: `Click the link to verify your email address:\n\n${url}`,
        })
      },
    }
  }

  return out
}
