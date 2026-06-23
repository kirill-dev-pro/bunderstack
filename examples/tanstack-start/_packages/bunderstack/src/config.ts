// src/config.ts
import { z } from 'zod'

import type { TableAccessInput } from './access.ts'
import type { IdempotencyConfig } from './idempotency.ts'
import type { RateLimitConfig } from './rate-limit.ts'

const StorageConfigSchema = z.union([
  z.object({ local: z.union([z.string(), z.literal(true)]) }),
  z.object({
    s3: z.union([
      z.literal(true),
      z.object({ endpoint: z.string().optional() }),
    ]),
  }),
])

export const BunderstackOptionsSchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  /** Auto-push schema in non-production. Set `true` to always provision, `false` to never. */
  provision: z.union([z.boolean(), z.literal('auto')]).optional(),
  access: z
    .record(
      z.string(),
      z.object({
        crud: z.boolean().optional(),
        ownerColumn: z.string().optional(),
        list: z.enum(['public', 'authenticated', 'owner', 'deny']).optional(),
        get: z.enum(['public', 'authenticated', 'owner', 'deny']).optional(),
        create: z.enum(['public', 'authenticated', 'owner', 'deny']).optional(),
        update: z.enum(['public', 'authenticated', 'owner', 'deny']).optional(),
        delete: z.enum(['public', 'authenticated', 'owner', 'deny']).optional(),
        writableColumns: z.array(z.string()).optional(),
        readonlyColumns: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  database: z
    .object({ url: z.string().optional(), authToken: z.string().optional() })
    .optional(),
  auth: z
    .object({
      emailPassword: z.boolean().optional(),
      secret: z.string().optional(),
      providers: z
        .object({
          github: z
            .object({ clientId: z.string(), clientSecret: z.string() })
            .optional(),
          google: z
            .object({ clientId: z.string(), clientSecret: z.string() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  storage: StorageConfigSchema.optional(),
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
})

export type BunderstackConfig<TSchema extends Record<string, unknown>> = Omit<
  z.input<typeof BunderstackOptionsSchema>,
  'schema' | 'access'
> & {
  schema: TSchema
  access?: Record<string, TableAccessInput>
  rateLimit?: boolean | RateLimitConfig
  idempotency?: boolean | IdempotencyConfig
}

export type ResolvedStorage =
  | { type: 'local'; path: string }
  | {
      type: 's3'
      bucket: string
      region: string
      endpoint?: string
      accessKeyId: string
      secretAccessKey: string
    }

type AuthProviders = NonNullable<
  NonNullable<z.infer<typeof BunderstackOptionsSchema>['auth']>['providers']
>

export type ResolvedConfig = {
  database: { url: string; authToken?: string }
  auth: { emailPassword: boolean; secret: string; providers: AuthProviders }
  storage: ResolvedStorage
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
    auth: {
      emailPassword: parsed.auth?.emailPassword ?? false,
      secret:
        parsed.auth?.secret ??
        process.env.AUTH_SECRET ??
        'dev-secret-change-in-prod',
      providers: parsed.auth?.providers ?? {},
    },
    storage: resolveStorage(parsed.storage),
  }
}

function resolveStorage(
  storage: z.infer<typeof StorageConfigSchema> | undefined,
): ResolvedStorage {
  if (!storage) return { type: 'local', path: './uploads' }
  if ('local' in storage)
    return {
      type: 'local',
      path: storage.local === true ? './uploads' : storage.local,
    }
  const s3Cfg = typeof storage.s3 === 'object' ? storage.s3 : {}
  return {
    type: 's3',
    bucket: process.env.S3_BUCKET ?? '',
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: s3Cfg.endpoint ?? process.env.S3_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  }
}
