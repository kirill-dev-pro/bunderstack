// src/storage/buckets.ts
import type { OperationRule, ScopeResolver } from '../access.ts'

// ---------------------------------------------------------------------------
// Input types (developer-facing config)
// ---------------------------------------------------------------------------

export type BucketBackendInput =
  | {
      s3: {
        bucket: string
        region?: string
        endpoint?: string
        publicUrl?: string
      }
    }
  | { local: string }

export type BucketConfigInput = {
  visibility?: 'public' | 'private'
  access?: {
    create?: OperationRule
    get?: OperationRule
    delete?: OperationRule
  }
  upload?: { maxSize?: string | number; accept?: string[] }
  transforms?: boolean
  scope?: ScopeResolver
  quota?: { perUser?: string | number; perScope?: string | number }
} & Partial<BucketBackendInput>

export type StorageConfigInput = {
  s3?: true | { endpoint?: string }
  local?: true | string
  defaultBucket?: string
  buckets?: Record<string, BucketConfigInput>
}

// ---------------------------------------------------------------------------
// Resolved types (internal)
// ---------------------------------------------------------------------------

export type ResolvedBackend =
  | { type: 'local'; path: string }
  | {
      type: 's3'
      bucket: string
      region: string
      endpoint?: string
      accessKeyId: string
      secretAccessKey: string
      publicUrl?: string
    }

export type ResolvedBucket = {
  name: string
  backend: ResolvedBackend
  visibility: 'public' | 'private'
  access: { create: OperationRule; get: OperationRule; delete: OperationRule }
  upload?: { maxSizeBytes?: number; accept?: string[] }
  transforms: boolean
  scope?: ScopeResolver
  quota?: { perUserBytes?: number; perScopeBytes?: number }
}

export type ResolvedStorageBuckets = {
  defaultBucket: string
  buckets: Map<string, ResolvedBucket>
}

// ---------------------------------------------------------------------------
// parseSize
// ---------------------------------------------------------------------------

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
}

export function parseSize(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`[bunderstack] invalid size "${value}"`)
    }
    return value
  }

  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`[bunderstack] invalid size "${value}"`)

  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(trimmed)
  if (!match) throw new Error(`[bunderstack] invalid size "${value}"`)

  const numStr = match[1]
  if (numStr === undefined)
    throw new Error(`[bunderstack] invalid size "${value}"`)
  const num = parseFloat(numStr)
  const unit = (match[2] ?? '').toLowerCase()

  if (unit === '') return Math.floor(num)

  const multiplier = SIZE_UNITS[unit]
  if (multiplier === undefined)
    throw new Error(`[bunderstack] invalid size "${value}"`)

  return Math.floor(num * multiplier)
}

// ---------------------------------------------------------------------------
// Shared backend resolution
// ---------------------------------------------------------------------------

function resolveSharedBackend(
  input: StorageConfigInput | undefined,
  env: Record<string, string | undefined>,
): ResolvedBackend {
  if (!input) return { type: 'local', path: './uploads' }

  if ('local' in input && input.local !== undefined) {
    return {
      type: 'local',
      path: input.local === true ? './uploads' : input.local,
    }
  }

  if ('s3' in input && input.s3 !== undefined) {
    const s3Cfg = typeof input.s3 === 'object' ? input.s3 : {}
    return {
      type: 's3',
      bucket: env['S3_BUCKET'] ?? '',
      region: env['S3_REGION'] ?? 'us-east-1',
      endpoint: s3Cfg.endpoint ?? env['S3_ENDPOINT'],
      accessKeyId: env['S3_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: env['S3_SECRET_ACCESS_KEY'] ?? '',
    }
  }

  return { type: 'local', path: './uploads' }
}

// ---------------------------------------------------------------------------
// Per-bucket backend resolution
// ---------------------------------------------------------------------------

function resolveBucketBackend(
  bucketInput: BucketConfigInput,
  sharedBackend: ResolvedBackend,
  env: Record<string, string | undefined>,
): ResolvedBackend {
  if ('s3' in bucketInput && bucketInput.s3 !== undefined) {
    const block = bucketInput.s3
    return {
      type: 's3',
      bucket: block.bucket,
      region: block.region ?? env['S3_REGION'] ?? 'us-east-1',
      endpoint: block.endpoint ?? env['S3_ENDPOINT'],
      accessKeyId: env['S3_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: env['S3_SECRET_ACCESS_KEY'] ?? '',
      publicUrl: block.publicUrl,
    }
  }

  if ('local' in bucketInput && bucketInput.local !== undefined) {
    return { type: 'local', path: bucketInput.local }
  }

  return sharedBackend
}

// ---------------------------------------------------------------------------
// Bucket resolution
// ---------------------------------------------------------------------------

function resolveSingleBucket(
  name: string,
  input: BucketConfigInput,
  sharedBackend: ResolvedBackend,
  env: Record<string, string | undefined>,
): ResolvedBucket {
  const visibility = input.visibility ?? 'private'
  const backend = resolveBucketBackend(input, sharedBackend, env)

  const defaultGet: OperationRule = visibility === 'public' ? 'public' : 'owner'

  const access: ResolvedBucket['access'] = {
    create: input.access?.create ?? 'authenticated',
    get: input.access?.get ?? defaultGet,
    delete: input.access?.delete ?? 'owner',
  }

  let upload: ResolvedBucket['upload'] | undefined = undefined
  if (input.upload !== undefined) {
    upload = {}
    if (input.upload.maxSize !== undefined) {
      upload.maxSizeBytes = parseSize(input.upload.maxSize)
    }
    if (input.upload.accept !== undefined) {
      upload.accept = input.upload.accept
    }
  }

  let quota: ResolvedBucket['quota'] | undefined = undefined
  if (input.quota !== undefined) {
    quota = {}
    if (input.quota.perUser !== undefined) {
      quota.perUserBytes = parseSize(input.quota.perUser)
    }
    if (input.quota.perScope !== undefined) {
      quota.perScopeBytes = parseSize(input.quota.perScope)
    }
  }

  return {
    name,
    backend,
    visibility,
    access,
    upload,
    transforms: input.transforms ?? false,
    scope: input.scope,
    quota,
  }
}

// ---------------------------------------------------------------------------
// resolveBuckets
// ---------------------------------------------------------------------------

export function resolveBuckets(
  input: StorageConfigInput | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedStorageBuckets {
  const defaultBucketName = input?.defaultBucket ?? 'default'
  const sharedBackend = resolveSharedBackend(input, env)
  const bucketsInput = input?.buckets

  const buckets = new Map<string, ResolvedBucket>()

  if (!bucketsInput || Object.keys(bucketsInput).length === 0) {
    // Synthesize a single default bucket
    const defaultBucket = resolveSingleBucket(
      defaultBucketName,
      {},
      sharedBackend,
      env,
    )
    buckets.set(defaultBucketName, defaultBucket)
    return { defaultBucket: defaultBucketName, buckets }
  }

  // Validate defaultBucket is declared
  if (!(defaultBucketName in bucketsInput)) {
    throw new Error(
      `[bunderstack] defaultBucket "${defaultBucketName}" is not a declared bucket`,
    )
  }

  for (const [name, bucketInput] of Object.entries(bucketsInput)) {
    buckets.set(
      name,
      resolveSingleBucket(name, bucketInput, sharedBackend, env),
    )
  }

  return { defaultBucket: defaultBucketName, buckets }
}
