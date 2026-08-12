// src/config.ts
import { betterAuth } from 'better-auth'
import * as v from 'valibot'

import type { AnyRouter } from '@orpc/server'
import type { AuthSessionResolver, TableAccessInput } from './access'
import type { BunderstackApiBuilder } from './api/builder'
import type { DatabaseAdapter } from './database/adapter'
import type { DbFor } from './db'
import type { AnyDb } from './dialect'
import type { EmailConfigInput } from './email'
import type { IdempotencyConfig } from './idempotency'
import type { RateLimitConfig } from './rate-limit'

import { validateEnv, type BaseEnv, type EnvConfigInput, type ValidatedEnv } from './env'
import {
  resolveBuckets,
  type ResolvedStorageBuckets,
  type StorageConfigInput,
} from './storage/buckets'

export type BetterAuthConfig = Omit<
  NonNullable<Parameters<typeof betterAuth>[0]>,
  'database'
>

/**
 * What an `auth` builder is handed. `db` is the app's own connection, typed
 * from `schema` alone — that is what keeps the builder cycle-free: better-auth
 * hooks living in another file get a db without importing the app whose type
 * they help produce.
 */
export type AuthConfigContext<
  TSchema extends Record<string, unknown>,
  TEnv extends EnvConfigInput | undefined = undefined,
> = {
  db: DbFor<TSchema>
  env: ValidatedEnv<TEnv>
}

export type AuthConfigInput<
  TSchema extends Record<string, unknown>,
  TEnv extends EnvConfigInput | undefined = undefined,
> =
  | BetterAuthConfig
  | ((ctx: AuthConfigContext<TSchema, TEnv>) => BetterAuthConfig)

/**
 * The builder as {@link ResolvedConfig} carries it: schema-agnostic, because
 * ResolvedConfig is not generic. {@link resolveAuthConfig} is the only caller.
 */
export type AuthConfigFactory = (ctx: {
  db: AnyDb
  env: BaseEnv
}) => BetterAuthConfig

// Only the union-shaped options need runtime validation: they are the ones a
// JavaScript caller can plausibly get wrong in a way that fails confusingly
// downstream. Everything else is either typed-only or read raw from `options`.
const RuntimeOptionsSchema = v.object({
  rateLimit: v.optional(
    v.union([
      v.boolean(),
      v.object({
        windowMs: v.optional(v.number()),
        max: v.optional(v.number()),
      }),
    ]),
  ),
  idempotency: v.optional(
    v.union([v.boolean(), v.object({ ttlMs: v.optional(v.number()) })]),
  ),
  realtime: v.optional(
    v.union([
      v.boolean(),
      v.object({
        bufferSize: v.optional(v.number()),
        resumeSeconds: v.optional(v.number()),
        redis: v.optional(
          v.union([
            v.string(),
            v.object({ url: v.string(), token: v.optional(v.string()) }),
          ]),
        ),
      }),
    ]),
  ),
  openapi: v.optional(v.boolean()),
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
  TCustomApiRouter extends AnyRouter | undefined = AnyRouter | undefined,
> = {
  schema: TSchema
  access?: TAccess
  database: {
    adapter: DatabaseAdapter
    url?: string
    authToken?: string
    migrations?: string
  }
  /**
   * better-auth options, or a builder receiving `{ db, env }`. Use the builder
   * form when database hooks need to write: it hands out the app's own
   * connection, so the application never opens a second one just to satisfy a
   * config that is built before the app exists.
   */
  auth?: AuthConfigInput<NoInfer<TSchema>, TEnv>
  /**
   * Reuse an application-owned session reader for the unified API while
   * keeping Bunderstack's auth handler available.
   */
  authResolver?: AuthSessionResolver
  storage?: TStorage
  env?: TEnv
  /**
   * Stand-in for `process.env`. Feeds both env validation and platform
   * overrides, so tests and embedders have one injection point instead of
   * three.
   */
  processEnv?: Record<string, string | undefined>
  background?: { autoStart?: boolean }
  email?: EmailConfigInput
  /**
   * Unified oRPC API builder callback.
   */
  api?: (
    builder: BunderstackApiBuilder<TSchema, ValidatedEnv<TEnv>>,
  ) => TCustomApiRouter
  rateLimit?: boolean | RateLimitConfig
  idempotency?: boolean | IdempotencyConfig
  /** Generate and serve `/api/openapi.json`. Disabled by default. */
  openapi?: boolean
  realtime?:
    | boolean
    | {
        bufferSize?: number
        resumeSeconds?: number
        redis?: string | { url: string; token?: string }
      }
}

export type ResolvedConfig = {
  database: {
    adapter: DatabaseAdapter
    url: string
    authToken?: string
    migrations: string
  }
  auth: BetterAuthConfig | AuthConfigFactory
  storage: ResolvedStorageBuckets
  realtime?:
    | boolean
    | {
        bufferSize?: number
        resumeSeconds?: number
        redis?: string | { url: string; token?: string }
      }
}

export function resolveConfig<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = undefined,
  TStorage extends StorageConfigInput | undefined = undefined,
  TEnv extends EnvConfigInput | undefined = undefined,
  TCustomApiRouter extends AnyRouter | undefined = undefined,
>(
  options: BunderstackConfig<
    TSchema,
    TAccess,
    TStorage,
    TEnv,
    TCustomApiRouter
  >,
  env?: BaseEnv,
  // Platform-injected overrides (Bunderhost & co.) beat code-level config so
  // apps with hardcoded local urls deploy unchanged.
  platformSource: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): ResolvedConfig {
  const parsed = v.parse(RuntimeOptionsSchema, options)
  // Self-validate when the caller didn't pass a pre-validated env, so
  // resolveConfig stays usable standalone.
  const resolvedEnv =
    env ?? validateEnv(options.env as EnvConfigInput | undefined)

  const adapter = options.database?.adapter
  if (!adapter) {
    throw new Error('[bunderstack] database.adapter is required')
  }

  const defaultUrl =
    adapter.dialect === 'sqlite' ? 'file:./data.db' : 'file:./data.pglite'

  return {
    database: {
      adapter,
      url:
        platformSource['BUNDERSTACK_DATABASE_URL'] ??
        options.database?.url ??
        resolvedEnv.DATABASE_URL ??
        defaultUrl,
      authToken:
        platformSource['BUNDERSTACK_DATABASE_AUTH_TOKEN'] ??
        options.database?.authToken ??
        resolvedEnv.DATABASE_AUTH_TOKEN,
      migrations: options.database?.migrations ?? './migrations',
    },
    auth: (() => {
      // The secret default has to survive the builder form too, and the builder
      // can only run once the db exists — so wrap it and default afterwards.
      const withSecret = (cfg: BetterAuthConfig): BetterAuthConfig => ({
        ...cfg,
        secret: cfg.secret ?? resolvedEnv.AUTH_SECRET,
      })
      const authInput = options.auth
      return typeof authInput === 'function'
        ? (((ctx) =>
            withSecret(authInput(ctx as never))) satisfies AuthConfigFactory)
        : withSecret(authInput ?? {})
    })(),
    storage: resolveBuckets(options.storage, platformSource),
    realtime: parsed.realtime,
  }
}

/** Collapse the object/builder union once the db is up. */
export function resolveAuthConfig(
  auth: ResolvedConfig['auth'],
  ctx: { db: AnyDb; env: BaseEnv },
): BetterAuthConfig {
  return typeof auth === 'function' ? auth(ctx) : auth
}

export function resolveRealtimeRedisUrl(
  realtime: ResolvedConfig['realtime'],
  env?: BaseEnv,
  platformSource: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): string | undefined {
  const platformRedis = platformSource['REDIS_URL']
  if (platformRedis) return platformRedis

  const envRedis = env?.REDIS_URL
  if (envRedis) return envRedis

  const fromConfig =
    typeof realtime === 'object' && realtime.redis
      ? typeof realtime.redis === 'string'
        ? realtime.redis
        : realtime.redis.url
      : undefined

  return fromConfig ?? undefined
}
