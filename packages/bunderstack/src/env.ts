// src/env.ts — env validation. Browser-safe: type-only Standard Schema import.
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  StandardSchemaValidationError,
  validateStandardSchema,
} from './standard-schema'

export const CLIENT_PREFIX = 'PUBLIC_' as const

/**
 * Static, value-free metadata about an environment key. It reaches the manifest
 * and the committed blueprint, so it must never contain a value or a secret.
 */
export type EnvVarMeta = {
  /**
   * Whether the value is a secret. Defaults to `true` for server keys and
   * `false` for client keys. A client key can never be sensitive: `PUBLIC_*`
   * values are compiled into the browser bundle.
   */
  sensitive?: boolean
  /** Prose shown to whoever fills this key in. Max 200 characters. */
  description?: string
}

export type EnvConfigInput = {
  server?: Record<string, StandardSchemaV1>
  client?: Record<string, StandardSchemaV1>
  /** Explicit value source for client vars (e.g. Vite's import.meta.env). */
  runtimeEnv?: Record<string, unknown>
  /** Value-free metadata per key, keyed by the key's own name. */
  meta?: Record<string, EnvVarMeta>
}

export type BunderstackRole = 'all' | 'web' | 'worker'

const ROLES: readonly BunderstackRole[] = ['all', 'web', 'worker']

/** Vars bunderstack itself consumes, always validated. */
export type BaseEnv = {
  NODE_ENV?: string
  DATABASE_URL: string
  DATABASE_AUTH_TOKEN?: string
  AUTH_SECRET: string
  REDIS_URL?: string
  RESEND_API_KEY?: string
  SMTP_URL?: string
  BUNDERSTACK_EMAIL_PROVIDER?: string
  BUNDERSTACK_EMAIL_FROM?: string
  BUNDERHOST_ENVIRONMENT_ID?: string
  /** Deployed commit SHA, injected by the platform. Reported by readiness. */
  BUNDERSTACK_REVISION?: string
  BUNDERSTACK_ROLE: BunderstackRole
}

type InferVars<T> =
  T extends Record<string, StandardSchemaV1>
    ? { [K in keyof T]: StandardSchemaV1.InferOutput<T[K]> }
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
  /** Dialect-aware DATABASE_URL fallback; bunderstack passes it. */
  defaultDatabaseUrl?: string
}

const DEV_AUTH_SECRET = 'dev-secret-change-in-prod'

function validateSection(
  section: Record<string, StandardSchemaV1> | undefined,
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
    try {
      out[key] = validateStandardSchema(schema, source[key], 'env')
    } catch (error) {
      if (!(error instanceof StandardSchemaValidationError)) throw error
      for (const issue of error.issues) {
        const path = issue.path.map(String).join('.')
        issues.push(`${key}${path ? `.${path}` : ''}: ${issue.message}`)
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
    DATABASE_URL:
      source.DATABASE_URL ?? options.defaultDatabaseUrl ?? 'file:./data.db',
    DATABASE_AUTH_TOKEN: source.DATABASE_AUTH_TOKEN,
    AUTH_SECRET: source.AUTH_SECRET ?? DEV_AUTH_SECRET,
    REDIS_URL: source.REDIS_URL,
    RESEND_API_KEY: source.RESEND_API_KEY,
    SMTP_URL: source.SMTP_URL,
    BUNDERSTACK_EMAIL_PROVIDER: source.BUNDERSTACK_EMAIL_PROVIDER,
    BUNDERSTACK_EMAIL_FROM: source.BUNDERSTACK_EMAIL_FROM,
    BUNDERHOST_ENVIRONMENT_ID: source.BUNDERHOST_ENVIRONMENT_ID,
    BUNDERSTACK_REVISION: source.BUNDERSTACK_REVISION,
    BUNDERSTACK_ROLE: (source.BUNDERSTACK_ROLE ?? 'all') as BunderstackRole,
  }
  if (isProduction && !source.AUTH_SECRET) {
    issues.push('AUTH_SECRET: required in production')
  }
  if (
    source.BUNDERSTACK_ROLE !== undefined &&
    !ROLES.includes(source.BUNDERSTACK_ROLE as BunderstackRole)
  ) {
    issues.push(
      `BUNDERSTACK_ROLE: must be one of ${ROLES.join(', ')} (got "${String(source.BUNDERSTACK_ROLE)}")`,
    )
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
