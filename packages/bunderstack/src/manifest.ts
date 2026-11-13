import type { StandardSchemaV1 } from '@standard-schema/spec'

import { getTableName, isTable } from 'drizzle-orm'
import * as v from 'valibot'

import type { BetterAuthConfig } from './config'
import type { Dialect } from './dialect'
import type { EnvConfigInput, EnvVarMeta } from './env'
import type { JobsDefs } from './jobs/define'
import type { MessagingConfig } from './messaging'
import type { ResolvedBucket, ResolvedStorageBuckets } from './storage/buckets'

import { missingAuthModels } from './auth'
import {
  bunderstackMessageEvents,
  bunderstackContacts,
  bunderstackContactAddresses,
  bunderstackContactTags,
  bunderstackBroadcasts,
  bunderstackBroadcastRecipients,
  bunderstackMessages,
  bunderstackFiles,
  bunderstackIdempotency,
  bunderstackJobs,
  bunderstackSeed,
} from './internal-tables'
import { parseCron } from './jobs/cron'
import { isMessagingDescriptor } from './messaging/types'
import {
  StandardSchemaValidationError,
  validateStandardSchema,
} from './standard-schema'

export type ManifestEnvVar = {
  key: string
  required: boolean
  scope: 'server' | 'client'
  sensitive: boolean
  description?: string
}

export type ApiOperationEffect = 'read' | 'mutation' | 'unknown'

/**
 * One application-declared procedure. `effect` is derived from the declared
 * HTTP method; `unknown` means the application declared no route, and a host
 * must treat it as at least as dangerous as a mutation.
 */
export type ApiOperation = {
  handle: string
  operationId: string
  effect: ApiOperationEffect
  method?: string
  path?: string
  summary?: string
}

export type ManagedIdentityCapability = {
  protocolVersion: 2
  adapterVersion: 2
  discovery: true
  callbackPath: '/api/auth/callback/bunderhost'
}
export const managedIdentitySchema = v.strictObject({
  protocolVersion: v.literal(2),
  adapterVersion: v.literal(2),
  discovery: v.literal(true),
  callbackPath: v.literal('/api/auth/callback/bunderhost'),
})
export type BunderstackManifest = {
  version: 4
  authentication?: { managedIdentity: ManagedIdentityCapability }
  database: {
    dialect: Dialect
    migrationsDirectory: string
    tables: { exportName: string; physicalName: string; system: boolean }[]
    /** Present when the application declares a seed; a host may offer it. */
    seed?: true
  }
  storage: {
    defaultBucket: string
    buckets: { name: string; visibility: ResolvedBucket['visibility'] }[]
  }
  realtime: { required: boolean }
  messaging: {
    channels: {
      name: string
      kind: string
      provider: string
      /** Present when the channel accepts mail the host routes to it. */
      receive?: true
    }[]
  }
  environment: ManifestEnvVar[]
  api: { operations: ApiOperation[] }
  background: {
    jobs: { name: string }[]
    cron: { name: string; schedule: string; timezone: 'UTC' }[]
    maintenance: {
      name: 'storage-sweep'
      schedule: string
      timezone: 'UTC'
    }[]
  }
}

const MAX_ENV_DESCRIPTION = 200

const nonEmpty = v.pipe(v.string(), v.minLength(1))
const migrationDirectory = v.pipe(
  nonEmpty,
  v.check(
    (value) =>
      value.startsWith('/') ||
      (!value.includes('\\') &&
        value.split('/').every((part) => part !== '..' && part !== '')),
    'migrationsDirectory must be an absolute path or a relative path without traversal',
  ),
)
const cronSchedule = v.pipe(
  nonEmpty,
  v.check((value) => {
    try {
      parseCron(value)
      return true
    } catch {
      return false
    }
  }, 'invalid cron schedule'),
)

const manifestSchema = v.strictObject({
  version: v.literal(4),
  authentication: v.optional(
    v.strictObject({ managedIdentity: managedIdentitySchema }),
  ),
  database: v.strictObject({
    dialect: v.picklist(['sqlite', 'pg']),
    migrationsDirectory: migrationDirectory,
    tables: v.array(
      v.strictObject({
        exportName: nonEmpty,
        physicalName: nonEmpty,
        system: v.boolean(),
      }),
    ),
    seed: v.optional(v.literal(true)),
  }),
  storage: v.strictObject({
    defaultBucket: nonEmpty,
    buckets: v.array(
      v.strictObject({
        name: nonEmpty,
        visibility: v.picklist(['public', 'private']),
      }),
    ),
  }),
  realtime: v.strictObject({ required: v.boolean() }),
  messaging: v.strictObject({
    channels: v.array(
      v.strictObject({
        name: nonEmpty,
        kind: nonEmpty,
        provider: nonEmpty,
        receive: v.optional(v.literal(true)),
      }),
    ),
  }),
  environment: v.array(
    v.strictObject({
      key: nonEmpty,
      required: v.boolean(),
      scope: v.picklist(['server', 'client']),
      sensitive: v.boolean(),
      description: v.optional(
        v.pipe(nonEmpty, v.maxLength(MAX_ENV_DESCRIPTION)),
      ),
    }),
  ),
  api: v.strictObject({
    operations: v.array(
      v.strictObject({
        handle: nonEmpty,
        operationId: nonEmpty,
        effect: v.picklist(['read', 'mutation', 'unknown']),
        method: v.optional(nonEmpty),
        path: v.optional(nonEmpty),
        summary: v.optional(v.pipe(nonEmpty, v.maxLength(200))),
      }),
    ),
  }),
  background: v.strictObject({
    jobs: v.array(v.strictObject({ name: nonEmpty })),
    cron: v.array(
      v.strictObject({
        name: nonEmpty,
        schedule: cronSchedule,
        timezone: v.literal('UTC'),
      }),
    ),
    maintenance: v.array(
      v.strictObject({
        name: v.literal('storage-sweep'),
        schedule: cronSchedule,
        timezone: v.literal('UTC'),
      }),
    ),
  }),
})

function sortBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  return [...entries].sort((left, right) => key(left).localeCompare(key(right)))
}

function rejectDuplicates(collection: string, values: readonly string[]): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value))
      throw new Error(`[bunderstack] duplicate ${collection} "${value}"`)
    seen.add(value)
  }
}

function describeTables(schema: Record<string, unknown>) {
  const systemNames = new Set<string>(
    systemTables().map((table) => table.physicalName),
  )
  return sortBy(
    Object.entries(schema).flatMap(([exportName, value]) =>
      isTable(value) && !systemNames.has(getTableName(value))
        ? [{ exportName, physicalName: getTableName(value), system: false }]
        : [],
    ),
    (entry) => entry.physicalName,
  )
}

function envDescription(key: string, value: string): string {
  const description = value.trim().replace(/\s+/g, ' ')
  if (!description)
    throw new Error(
      `[bunderstack] env.meta.${key}.description must not be empty`,
    )
  if (description.length > MAX_ENV_DESCRIPTION)
    throw new Error(
      `[bunderstack] env.meta.${key}.description must be at most ${MAX_ENV_DESCRIPTION} characters`,
    )
  return description
}

function describeSection(
  section: Record<string, StandardSchemaV1> | undefined,
  scope: ManifestEnvVar['scope'],
  meta: Record<string, EnvVarMeta> | undefined,
): ManifestEnvVar[] {
  return Object.entries(section ?? {}).map(([key, schema]) => {
    let required = false
    try {
      validateStandardSchema(schema, undefined, 'env')
    } catch (error) {
      if (!(error instanceof StandardSchemaValidationError)) throw error
      required = true
    }
    const entry = meta?.[key]
    const sensitive = entry?.sensitive ?? scope === 'server'
    if (scope === 'client' && sensitive) {
      throw new Error(
        `[bunderstack] env.meta.${key}.sensitive must be false: client values ship to the browser`,
      )
    }
    return {
      key,
      required,
      scope,
      sensitive,
      ...(entry?.description === undefined
        ? {}
        : { description: envDescription(key, entry.description) }),
    }
  })
}

function systemTables() {
  return [
    {
      exportName: '_system.broadcastRecipients',
      physicalName: getTableName(bunderstackBroadcastRecipients),
      system: true,
    },
    {
      exportName: '_system.broadcasts',
      physicalName: getTableName(bunderstackBroadcasts),
      system: true,
    },
    {
      exportName: '_system.contacts',
      physicalName: getTableName(bunderstackContacts),
      system: true,
    },
    {
      exportName: '_system.contactAddresses',
      physicalName: getTableName(bunderstackContactAddresses),
      system: true,
    },
    {
      exportName: '_system.contactTags',
      physicalName: getTableName(bunderstackContactTags),
      system: true,
    },
    {
      exportName: '_system.messageEvents',
      physicalName: getTableName(bunderstackMessageEvents),
      system: true,
    },
    {
      exportName: '_system.messages',
      physicalName: getTableName(bunderstackMessages),
      system: true,
    },
    {
      exportName: '_system.files',
      physicalName: getTableName(bunderstackFiles),
      system: true,
    },
    {
      exportName: '_system.idempotency',
      physicalName: getTableName(bunderstackIdempotency),
      system: true,
    },
    {
      exportName: '_system.jobs',
      physicalName: getTableName(bunderstackJobs),
      system: true,
    },
    {
      exportName: '_system.seed',
      physicalName: getTableName(bunderstackSeed),
      system: true,
    },
  ]
}

export function parseManifest(value: unknown): BunderstackManifest {
  const manifest = validateStandardSchema(
    manifestSchema,
    value,
    'manifest',
  ) as BunderstackManifest
  rejectDuplicates(
    'database physical table',
    manifest.database.tables.map((entry) => entry.physicalName),
  )
  rejectDuplicates(
    'database export table',
    manifest.database.tables.map((entry) => entry.exportName),
  )
  rejectDuplicates(
    'storage bucket',
    manifest.storage.buckets.map((entry) => entry.name),
  )
  rejectDuplicates(
    'environment key',
    manifest.environment.map((entry) => entry.key),
  )
  rejectDuplicates(
    'messaging channel',
    manifest.messaging.channels.map((entry) => entry.name),
  )
  rejectDuplicates(
    'api operation',
    manifest.api.operations.map((entry) => entry.handle),
  )
  rejectDuplicates(
    'background job',
    manifest.background.jobs.map((entry) => entry.name),
  )
  rejectDuplicates(
    'background cron',
    manifest.background.cron.map((entry) => entry.name),
  )
  rejectDuplicates(
    'background maintenance',
    manifest.background.maintenance.map((entry) => entry.name),
  )
  return manifest
}

export function buildManifest(args: {
  auth?: BetterAuthConfig | 'builder'
  schema: Record<string, unknown>
  dialect: Dialect
  migrationsDirectory: string
  /** Whether the application declares a seed. */
  seed?: boolean
  storage: ResolvedStorageBuckets
  envConfig: EnvConfigInput | undefined
  messaging: MessagingConfig | undefined
  realtime: boolean
  jobs: JobsDefs | undefined
  api: ApiOperation[]
}): BunderstackManifest {
  for (const [name, descriptor] of Object.entries(args.messaging ?? {})) {
    if (!name.trim()) {
      throw new Error('[bunderstack] messaging channel names cannot be empty')
    }
    if (!isMessagingDescriptor(descriptor)) {
      throw new Error(
        `[bunderstack] messaging.${name} is not a provider descriptor`,
      )
    }
  }
  const receiving = new Set(
    Object.entries(args.messaging ?? {})
      .filter(([, descriptor]) => receives(descriptor))
      .map(([name]) => name),
  )
  assertInboundHandlers(receiving, args.jobs, args.messaging)
  const declaredKeys = new Set([
    ...Object.keys(args.envConfig?.server ?? {}),
    ...Object.keys(args.envConfig?.client ?? {}),
  ])
  for (const key of Object.keys(args.envConfig?.meta ?? {})) {
    if (!declaredKeys.has(key))
      throw new Error(
        `[bunderstack] env.meta references undeclared key "${key}"`,
      )
  }
  const environment = [
    ...describeSection(args.envConfig?.server, 'server', args.envConfig?.meta),
    ...describeSection(args.envConfig?.client, 'client', args.envConfig?.meta),
  ]
  const auth = args.auth === 'builder' ? {} : (args.auth ?? {})
  const capable =
    auth.managedIdentity !== false &&
    missingAuthModels(args.schema, auth).length === 0 &&
    Boolean(args.schema[auth.account?.modelName ?? 'account']) &&
    Boolean(args.schema[auth.verification?.modelName ?? 'verification'])
  if (capable) {
    const reserved = environment.find((e) => e.key === 'BUNDERHOST_AUTH_CONFIG')
    if (reserved && (reserved.scope !== 'server' || !reserved.sensitive))
      throw new Error(
        '[bunderstack] BUNDERHOST_AUTH_CONFIG must be sensitive and server-only',
      )
    if (!reserved)
      environment.push({
        key: 'BUNDERHOST_AUTH_CONFIG',
        required: false,
        scope: 'server',
        sensitive: true,
      })
  }
  rejectDuplicates(
    'environment key',
    environment.map((entry) => entry.key),
  )

  return parseManifest({
    version: 4,
    ...(capable
      ? {
          authentication: {
            managedIdentity: {
              protocolVersion: 2 as const,
              adapterVersion: 2 as const,
              discovery: true as const,
              callbackPath: '/api/auth/callback/bunderhost' as const,
            },
          },
        }
      : {}),
    database: {
      dialect: args.dialect,
      migrationsDirectory: args.migrationsDirectory,
      tables: sortBy(
        [...systemTables(), ...describeTables(args.schema)],
        (entry) => entry.physicalName,
      ),
      ...(args.seed ? { seed: true as const } : {}),
    },
    storage: {
      defaultBucket: args.storage.defaultBucket,
      buckets: sortBy(
        [...args.storage.buckets.values()].map((bucket) => ({
          name: bucket.name,
          visibility: bucket.visibility,
        })),
        (bucket) => bucket.name,
      ),
    },
    realtime: { required: args.realtime },
    messaging: {
      channels: sortBy(
        Object.entries(args.messaging ?? {}).map(([name, descriptor]) => ({
          name,
          kind: descriptor.kind,
          provider: descriptor.provider,
          ...(receiving.has(name) ? { receive: true as const } : {}),
        })),
        (entry) => entry.name,
      ),
    },
    environment: sortBy(environment, (entry) => entry.key),
    api: {
      operations: [...args.api].sort((left, right) =>
        left.handle.localeCompare(right.handle),
      ),
    },
    background: {
      jobs: sortBy(
        Object.entries(args.jobs ?? {})
          .filter(([, def]) => def.kind === 'job')
          .map(([name]) => ({ name })),
        (entry) => entry.name,
      ),
      cron: sortBy(
        Object.entries(args.jobs ?? {})
          .filter(([, def]) => def.kind === 'cron')
          .map(([name, def]) => ({
            name,
            schedule: def.kind === 'cron' ? def.schedule : '',
            timezone: 'UTC' as const,
          })),
        (entry) => entry.name,
      ),
      maintenance: [
        {
          name: 'storage-sweep',
          schedule: '0 4 * * *',
          timezone: 'UTC' as const,
        },
      ],
    },
  })
}

function receives(descriptor: unknown): boolean {
  return (
    isMessagingDescriptor(descriptor) &&
    descriptor.kind === 'email' &&
    (descriptor.config as { receive?: unknown }).receive === true
  )
}

/**
 * A receiving channel needs exactly one handler, and a handler needs a
 * channel that receives: mail with nowhere to go would be journaled and then
 * sit there, and a handler for a channel that never receives is a typo.
 */
function assertInboundHandlers(
  receiving: ReadonlySet<string>,
  jobs: JobsDefs | undefined,
  messaging: MessagingConfig | undefined,
): void {
  const handlers = new Map<string, string[]>()
  for (const [name, def] of Object.entries(jobs ?? {})) {
    if (def.kind !== 'job' || def.inbound === undefined) continue
    if (!receiving.has(def.inbound)) {
      throw new Error(
        messaging?.[def.inbound]
          ? `[bunderstack] job "${name}" handles messaging.${def.inbound}, which does not receive mail — declare it with receive: true`
          : `[bunderstack] job "${name}" handles messaging.${def.inbound}, which is not declared`,
      )
    }
    handlers.set(def.inbound, [...(handlers.get(def.inbound) ?? []), name])
  }
  for (const channel of receiving) {
    const names = handlers.get(channel) ?? []
    if (names.length === 0) {
      throw new Error(
        `[bunderstack] messaging.${channel} receives mail but no jobs.inbound('${channel}', …) handles it`,
      )
    }
    if (names.length > 1) {
      throw new Error(
        `[bunderstack] messaging.${channel} has more than one jobs.inbound handler: ${names.join(', ')}`,
      )
    }
  }
}
