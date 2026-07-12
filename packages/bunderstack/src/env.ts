// src/env.ts — env validation. Browser-safe: imports zod only.
import { z, type ZodType } from 'zod'

export const CLIENT_PREFIX = 'PUBLIC_' as const

export type EnvConfigInput = {
  server?: Record<string, ZodType>
  client?: Record<string, ZodType>
  /** Explicit value source for client vars (e.g. Vite's import.meta.env). */
  runtimeEnv?: Record<string, unknown>
}

/** Vars bunderstack itself consumes, always validated. */
export type BaseEnv = {
  NODE_ENV?: string
  DATABASE_URL: string
  DATABASE_AUTH_TOKEN?: string
  AUTH_SECRET: string
  REDIS_URL?: string
  RESEND_API_KEY?: string
  SMTP_URL?: string
}

type InferVars<T> = T extends Record<string, ZodType>
  ? { [K in keyof T]: z.output<T[K]> }
  : unknown

// Non-distributive so `ValidatedEnv<undefined>` is BaseEnv, not `never`.
export type ValidatedEnv<TEnv extends EnvConfigInput | undefined> = [
  TEnv,
] extends [EnvConfigInput]
  ? BaseEnv &
      InferVars<NonNullable<TEnv>['server']> &
      InferVars<NonNullable<TEnv>['client']>
  : BaseEnv

export class BunderstackEnvError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid environment:\n  - ${issues.join('\n  - ')}`)
    this.name = 'BunderstackEnvError'
    this.issues = issues
  }
}

export type ValidateEnvOptions = {
  /** String tag of the configured email provider ('resend' | 'smtp'), if any. */
  emailProvider?: string
  /** Value source; defaults to process.env. Tests pass this explicitly. */
  source?: Record<string, string | undefined>
}

const DEV_AUTH_SECRET = 'dev-secret-change-in-prod'

function validateSection(
  section: Record<string, ZodType> | undefined,
  kind: 'server' | 'client',
  source: Record<string, unknown>,
  issues: string[],
  out: Record<string, unknown>,
) {
  for (const [key, schema] of Object.entries(section ?? {})) {
    const isPublic = key.startsWith(CLIENT_PREFIX)
    if (kind === 'server' && isPublic) {
      issues.push(
        `${key}: server vars must not start with ${CLIENT_PREFIX} (move it to env.client)`,
      )
      continue
    }
    if (kind === 'client' && !isPublic) {
      issues.push(
        `${key}: client vars must start with ${CLIENT_PREFIX} (rename it or move it to env.server)`,
      )
      continue
    }
    const result = schema.safeParse(source[key])
    if (result.success) {
      out[key] = result.data
    } else {
      for (const issue of result.error.issues) {
        issues.push(`${key}: ${issue.message}`)
      }
    }
  }
}

export function validateEnv<TEnv extends EnvConfigInput | undefined>(
  envConfig: TEnv,
  options: ValidateEnvOptions = {},
): ValidatedEnv<TEnv> {
  const source =
    options.source ?? (process.env as Record<string, string | undefined>)
  const issues: string[] = []
  const isProduction = source.NODE_ENV === 'production'

  const base: BaseEnv = {
    NODE_ENV: source.NODE_ENV,
    DATABASE_URL: source.DATABASE_URL ?? 'file:./data.db',
    DATABASE_AUTH_TOKEN: source.DATABASE_AUTH_TOKEN,
    AUTH_SECRET: source.AUTH_SECRET ?? DEV_AUTH_SECRET,
    REDIS_URL: source.REDIS_URL,
    RESEND_API_KEY: source.RESEND_API_KEY,
    SMTP_URL: source.SMTP_URL,
  }
  if (isProduction && !source.AUTH_SECRET) {
    issues.push('AUTH_SECRET: required in production')
  }
  if (options.emailProvider === 'resend' && !source.RESEND_API_KEY) {
    issues.push("RESEND_API_KEY: required when email provider is 'resend'")
  }
  if (options.emailProvider === 'smtp' && !source.SMTP_URL) {
    issues.push("SMTP_URL: required when email provider is 'smtp'")
  }

  const userVars: Record<string, unknown> = {}
  validateSection(envConfig?.server, 'server', source, issues, userVars)
  validateSection(envConfig?.client, 'client', source, issues, userVars)

  if (issues.length > 0) throw new BunderstackEnvError(issues)
  return { ...base, ...userVars } as ValidatedEnv<TEnv>
}

/**
 * Browser-side companion (t3-env style): validates ONLY the client section.
 * Server keys exist on the returned object as traps that throw on access, so
 * a leaked import fails loudly instead of silently reading undefined.
 */
export function createClientEnv<TEnv extends EnvConfigInput>(
  envConfig: TEnv,
): InferVars<TEnv['client']> {
  const source =
    envConfig.runtimeEnv ??
    (typeof process !== 'undefined'
      ? (process.env as Record<string, unknown>)
      : {})
  const issues: string[] = []
  const values: Record<string, unknown> = {}
  validateSection(envConfig.client, 'client', source, issues, values)
  if (issues.length > 0) throw new BunderstackEnvError(issues)

  const serverKeys = new Set(Object.keys(envConfig.server ?? {}))
  return new Proxy(values, {
    get(target, prop) {
      if (typeof prop === 'string' && serverKeys.has(prop)) {
        throw new Error(
          `${prop} is server-only and not available in client env`,
        )
      }
      return Reflect.get(target, prop)
    },
  }) as InferVars<TEnv['client']>
}
