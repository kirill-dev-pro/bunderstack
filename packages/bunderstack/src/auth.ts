// src/auth.ts
import { betterAuth, type Auth, type BetterAuthPlugin } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { openAPI } from 'better-auth/plugins'

import type { AuthSessionResolver } from './access'
import type { BetterAuthConfig } from './config'
import type { AnyDb, Dialect } from './dialect'
import type { EmailFacade } from './email'

type ConfiguredAuthPlugins<TConfig extends BetterAuthConfig> = TConfig extends {
  plugins: infer TPlugins extends readonly BetterAuthPlugin[]
}
  ? TPlugins
  : []

type WithBunderstackAuthDefaults<TConfig extends BetterAuthConfig> = Omit<
  BetterAuthConfig,
  'plugins'
> &
  Omit<TConfig, 'plugins'> & {
    plugins: [...ConfiguredAuthPlugins<TConfig>, ReturnType<typeof openAPI>]
  }

/**
 * The public Better Auth instance retains every endpoint and model field from
 * the declared config. Bunderstack always installs OpenAPI at runtime, so its
 * endpoints are part of the public type even when the app omitted the plugin.
 */
export type BunderstackAuth<
  TConfig extends BetterAuthConfig = BetterAuthConfig,
> = Auth<WithBunderstackAuthDefaults<TConfig>> & Auth

/**
 * Build Better Auth while exposing its named plugin-aware public type. The
 * implementation accepts the resolved runtime config, while `TConfig` carries
 * the declaration that produced it; their relationship is asserted once here.
 */
export function createAuth<TConfig extends BetterAuthConfig = BetterAuthConfig>(
  db: AnyDb,
  cfg: BetterAuthConfig,
  dialect: Dialect,
  userSchema?: Record<string, unknown>,
): BunderstackAuth<TConfig> {
  const hasOpenApi = cfg.plugins?.some((p: any) => p.id === 'open-api')
  const plugins = hasOpenApi ? cfg.plugins : [...(cfg.plugins || []), openAPI()]

  return betterAuth({
    ...cfg,
    plugins,
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: dialect === 'pg' ? 'pg' : 'sqlite',
      ...(userSchema ? { schema: userSchema } : {}),
    }),
  }) as unknown as BunderstackAuth<TConfig>
}

/**
 * better-auth resolves its models out of the app's own schema, so an app that
 * declares none has no auth at all. Session resolution must then short-circuit
 * to null: the drizzle adapter throws on a missing model, and any session
 * cookie for the host — a browser keeps those per host, not per port, so one
 * minted by another local app arrives here too — would break every request.
 */
export function missingAuthModels(
  schema: Record<string, unknown>,
  cfg: BetterAuthConfig,
): string[] {
  const models = [
    cfg.user?.modelName ?? 'user',
    cfg.session?.modelName ?? 'session',
  ]
  return models.filter((model) => !schema[model])
}

/**
 * Adapt the raw better-auth instance to our internal {@link AuthSessionResolver}
 * contract. better-auth's `getSession` has a union return (a bare session, or a
 * `{ headers, response }` wrapper when `returnHeaders` is set); we only ever
 * call the bare form, so we narrow on `'user' in result` and map to our shape.
 * Keeping this adapter here means internal modules never depend on better-auth's
 * evolving types.
 */
export function toAuthSessionResolver(auth: Auth): AuthSessionResolver {
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
