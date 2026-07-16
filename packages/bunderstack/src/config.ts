// src/config.ts
import { betterAuth } from 'better-auth'
import { z } from 'zod'

import type { TableAccessInput } from './access'
import type { IdempotencyConfig } from './idempotency'
import type { RateLimitConfig } from './rate-limit'

import { validateEnv, type BaseEnv, type EnvConfigInput } from './env'
import type { EmailConfigInput } from './email'

import {
  resolveBuckets,
  type ResolvedStorageBuckets,
  type StorageConfigInput,
} from './storage/buckets'

export type BetterAuthConfig = Omit<
  NonNullable<Parameters<typeof betterAuth>[0]>,
  'database'
>

export const BunderstackOptionsSchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  access: z.record(z.string(), z.any()).optional(),
  database: z
    .object({
      url: z.string().optional(),
      authToken: z.string().optional(),
      migrations: z.string().optional(),
    })
    .optional(),
  auth: z.record(z.string(), z.unknown()).optional(),
  // Loose: bucket access/scope hold functions that can't survive strict zod
  // (mirrors how `access` is loose). Resolution happens in resolveBuckets.
  storage: z.unknown().optional(),
  // Loose: holds zod schemas. Validation happens in validateEnv.
  env: z.unknown().optional(),
  // Loose: provider may be a function/adapter. Resolution happens in createEmail.
  email: z.unknown().optional(),
  // Loose: a tRPC router or builder callback. Resolved in createBunderstack.
  trpc: z.unknown().optional(),
  rateLimit: z
    .union([
      z.boolean(),
      z.object({
        windowMs: z.number().optional(),
        max: z.number().optional(),
      }),
    ])
    .optional(),
  idempotency: z
    .union([z.boolean(), z.object({ ttlMs: z.number().optional() })])
    .optional(),
  realtime: z
    .union([
      z.boolean(),
      z.object({
        keepaliveMs: z.number().optional(),
        bufferSize: z.number().optional(),
        redis: z
          .union([
            z.string(),
            z.object({ url: z.string(), token: z.string().optional() }),
          ])
          .optional(),
      }),
    ])
    .optional(),
})

export type BunderstackConfig<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined =
    | Record<string, TableAccessInput>
    | undefined,
  TStorage extends StorageConfigInput | undefined =
    | StorageConfigInput
    | undefined,
  TEnv extends EnvConfigInput | undefined = EnvConfigInput | undefined,
> = Omit<
  z.input<typeof BunderstackOptionsSchema>,
  'schema' | 'access' | 'auth' | 'storage' | 'env' | 'email' | 'trpc'
> & {
  schema: TSchema
  access?: TAccess
  auth?: BetterAuthConfig
  storage?: TStorage
  env?: TEnv
  email?: EmailConfigInput
  // `trpc` is intentionally NOT declared here: createBunderstack intersects
  // its own inference-friendly `trpc` declaration (router | builder callback)
  // so the callback's `t` parameter gets contextual typing.
  rateLimit?: boolean | RateLimitConfig
  idempotency?: boolean | IdempotencyConfig
  realtime?:
    | boolean
    | {
        keepaliveMs?: number
        bufferSize?: number
        redis?: string | { url: string; token?: string }
      }
}

export type ResolvedConfig = {
  database: { url: string; authToken?: string; migrations: string }
  auth: BetterAuthConfig
  storage: ResolvedStorageBuckets
  realtime?:
    | boolean
    | {
        keepaliveMs?: number
        bufferSize?: number
        redis?: string | { url: string; token?: string }
      }
}

export function resolveConfig<TSchema extends Record<string, unknown>>(
  options: BunderstackConfig<TSchema>,
  env?: BaseEnv,
  // Platform-injected overrides (Bunderhost & co.) beat code-level config so
  // apps with hardcoded local urls deploy unchanged.
  platformSource: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): ResolvedConfig {
  const parsed = BunderstackOptionsSchema.parse(options)
  // Self-validate when the caller didn't pass a pre-validated env, so
  // resolveConfig stays usable standalone.
  const resolvedEnv =
    env ?? validateEnv(options.env as EnvConfigInput | undefined)

  return {
    database: {
      url:
        platformSource['BUNDERSTACK_DATABASE_URL'] ??
        parsed.database?.url ??
        resolvedEnv.DATABASE_URL,
      authToken:
        platformSource['BUNDERSTACK_DATABASE_AUTH_TOKEN'] ??
        parsed.database?.authToken ??
        resolvedEnv.DATABASE_AUTH_TOKEN,
      migrations: parsed.database?.migrations ?? './migrations',
    },
    auth: (() => {
      const authInput = options.auth ?? {}
      return {
        ...authInput,
        secret: authInput.secret ?? resolvedEnv.AUTH_SECRET,
      }
    })(),
    storage: resolveBuckets(options.storage, platformSource),
    realtime: parsed.realtime,
  }
}

export function resolveRealtimeRedisUrl(
  realtime: ResolvedConfig['realtime'],
  env?: BaseEnv,
): string | undefined {
  const fromConfig =
    typeof realtime === 'object' && realtime.redis
      ? typeof realtime.redis === 'string'
        ? realtime.redis
        : realtime.redis.url
      : undefined
  return fromConfig ?? env?.REDIS_URL ?? process.env.REDIS_URL ?? undefined
}
