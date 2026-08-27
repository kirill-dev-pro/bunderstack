import type {
  ResolvedStorageBuckets,
  StorageConfigInput,
} from '../storage/buckets'

import { resolveBuckets } from '../storage/buckets'
import { createBucketStorages } from '../storage/registry'

export type TestStorage = {
  read(key: string): Promise<Uint8Array>
}

export function resolveTestBuckets(
  input: StorageConfigInput | undefined,
  root: string,
): ResolvedStorageBuckets {
  const resolved = resolveBuckets(input, {})
  return {
    defaultBucket: resolved.defaultBucket,
    buckets: new Map(
      [...resolved.buckets].map(([name, bucket]) => [
        name,
        { ...bucket, backend: { type: 'local' as const, path: root } },
      ]),
    ),
  }
}

export function createTestStorage(
  resolved: ResolvedStorageBuckets,
): TestStorage {
  const registry = createBucketStorages(resolved)
  return {
    async read(key) {
      const bucketName = key.split('/')[0] || resolved.defaultBucket
      const adapter = registry.get(bucketName)?.adapter
      if (!adapter) throw new Error(`Unknown bucket: ${bucketName}`)
      const response = await adapter.get(key)
      if (!response.ok) {
        throw new Error(`Storage object not found: ${key}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}
