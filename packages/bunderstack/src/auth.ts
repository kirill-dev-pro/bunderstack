// src/auth.ts
import { betterAuth, type Auth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { openAPI } from 'better-auth/plugins'

import type { AuthSessionResolver } from './access'
import type { BetterAuthConfig } from './config'
import type { AnyDb, Dialect } from './dialect'
import type { EmailFacade } from './email'

/**
 * Returns better-auth's plain `Auth`, not the plugin-parameterised type its
 * builder infers: declaration emit would otherwise inline that whole inferred
 * options object into the published `.d.ts`, where it no longer satisfies
 * better-auth's own `BetterAuthOptions` constraint. Plugin-specific endpoints
 * are reached through runtime checks (see the OpenAPI schema lookup in
 * `index.ts`), so nothing depends on the wider type.
 */
export function createAuth(
  db: AnyDb,
  cfg: BetterAuthConfig,
  dialect: Dialect,
  userSchema?: Record<string, unknown>,
): Auth {
  const hasOpenApi = cfg.plugins?.some((p: any) => p.id === 'open-api')
  const plugins = hasOpenApi ? cfg.plugins : [...(cfg.plugins || []), openAPI()]

  // Type-only narrowing: the value is unchanged, but the published signature
  // stays a type better-auth itself can name.
  return betterAuth({
    ...cfg,
    plugins,
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: dialect === 'pg' ? 'pg' : 'sqlite',
      ...(userSchema ? { schema: userSchema } : {}),
    }),
  }) as unknown as Auth
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
          const role =
            'role' in result.user && typeof result.user.role === 'string'
              ? result.user.role
              : undefined
          return {
            user: {
              id: result.user.id,
              email: result.user.email,
              name: result.user.name,
              ...(role ? { role } : {}),
            },
            session: session ? { activeOrganizationId } : null,
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

  if (
    cfg.emailAndPassword?.enabled &&
    !cfg.emailAndPassword.sendResetPassword
  ) {
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
