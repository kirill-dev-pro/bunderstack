// src/config.ts
import { betterAuth } from 'better-auth'
import { z } from 'zod'

import type { TableAccessInput } from './access.ts'
import type { IdempotencyConfig } from './idempotency.ts'
import type { RateLimitConfig } from './rate-limit.ts'
import {
  resolveBuckets,
  type ResolvedStorageBuckets,
  type StorageConfigInput,
} from './storage/buckets.ts'

export type BetterAuthConfig = Omit<
  NonNullable<Parameters<typeof betterAuth>[0]>,
  'database'
>

export const BunderstackOptionsSchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  /** Auto-push schema in non-production. Set `true` to always provision, `false` to never. */
  provision: z.union([z.boolean(), z.literal('auto')]).optional(),
  access: z.record(z.string(), z.any()).optional(),
  database: z
    .object({ url: z.string().optional(), authToken: z.string().optional() })
    .optional(),
  auth: z.record(z.unknown()).optional(),
  // Loose: bucket access/scope hold functions that can't survive strict zod
  // (mirrors how `access` is loose). Resolution happens in resolveBuckets.
  storage: z.unknown().optional(),
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
          .union([z.string(), z.object({ url: z.string(), token: z.string().optional() })])
          .optional(),
      }),
    ])
    .optional(),
})

export type BunderstackConfig<TSchema extends Record<string, unknown>> = Omit<
  z.input<typeof BunderstackOptionsSchema>,
  'schema' | 'access' | 'auth' | 'storage'
> & {
  schema: TSchema
  access?: Record<string, TableAccessInput>
  auth?: BetterAuthConfig
  storage?: StorageConfigInput
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
  database: { url: string; authToken?: string }
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
): ResolvedConfig {
  const parsed = BunderstackOptionsSchema.parse(options)

  return {
    database: {
      url: parsed.database?.url ?? process.env.DATABASE_URL ?? 'file:./data.db',
      authToken: parsed.database?.authToken ?? process.env.DATABASE_AUTH_TOKEN,
    },
    auth: (() => {
      const authInput = (parsed.auth ?? {}) as BetterAuthConfig
      return {
        ...authInput,
        secret:
          authInput.secret ??
          process.env.AUTH_SECRET ??
          'dev-secret-change-in-prod',
      }
    })(),
    storage: resolveBuckets(parsed.storage as StorageConfigInput | undefined),
    realtime: parsed.realtime,
  }
}

export function resolveRealtimeRedisUrl(
  realtime: ResolvedConfig['realtime'],
): string | undefined {
  const fromConfig =
    typeof realtime === 'object' && realtime.redis
      ? typeof realtime.redis === 'string'
        ? realtime.redis
        : realtime.redis.url
      : undefined
  return fromConfig ?? process.env.REDIS_URL ?? undefined
}
