// src/storage/registry.ts
import type { ResolvedBackend, ResolvedBucket, ResolvedStorageBuckets } from './buckets.ts'
import type { StorageAdapter } from './index.ts'

import { LocalStorageAdapter } from './local.ts'
import { S3StorageAdapter } from './s3.ts'

export interface BucketStorage { bucket: ResolvedBucket; adapter: StorageAdapter }
export type BucketStorageRegistry = Map<string, BucketStorage>

export function createAdapter(backend: ResolvedBackend): StorageAdapter {
  if (backend.type === 'local') {
    return new LocalStorageAdapter(backend.path)
  }
  return new S3StorageAdapter({
    bucket: backend.bucket,
    region: backend.region,
    accessKeyId: backend.accessKeyId,
    secretAccessKey: backend.secretAccessKey,
    endpoint: backend.endpoint,
    publicUrl: backend.publicUrl,
  })
}

export function createBucketStorages(resolved: ResolvedStorageBuckets): BucketStorageRegistry {
  const registry: BucketStorageRegistry = new Map()
  for (const [name, bucket] of resolved.buckets) {
    registry.set(name, { bucket, adapter: createAdapter(bucket.backend) })
  }
  return registry
}
