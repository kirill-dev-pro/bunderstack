// src/workers/r2.ts — storage on an R2 binding. Presign needs S3 keys to the
// same bucket; without them uploads go through the Worker (proxy mode).
import type { StorageAdapterFactory } from '../platform'
import type {
  PresignGetOptions,
  PresignPutOptions,
  StorageAdapter,
} from '../storage/index'
import type { R2BucketLike, WorkerEnv } from './types'

import { S3StorageAdapter } from '../storage/s3'

export function bucketBindingName(bucketName: string): string {
  return `BUCKET_${bucketName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export class R2StorageAdapter implements StorageAdapter {
  presignPut?: (key: string, opts: PresignPutOptions) => Promise<string>
  presignGet?: (key: string, opts: PresignGetOptions) => Promise<string>
  publicUrlFor?: (key: string) => string | undefined

  constructor(
    private readonly bucket: R2BucketLike,
    presigner?: S3StorageAdapter,
  ) {
    if (presigner) {
      this.presignPut = (key, opts) => presigner.presignPut(key, opts)
      this.presignGet = (key, opts) => presigner.presignGet(key, opts)
      this.publicUrlFor = (key) => presigner.publicUrlFor(key)
    }
  }

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await this.bucket.put(fileId, bytes, { httpMetadata: { contentType } })
  }

  async get(fileId: string): Promise<Response> {
    const object = await this.bucket.get(fileId)
    if (!object) return new Response('Not found', { status: 404 })
    return new Response(object.body, {
      headers: {
        'Content-Type':
          object.httpMetadata?.contentType || 'application/octet-stream',
      },
    })
  }

  async delete(fileId: string) {
    await this.bucket.delete(fileId)
  }

  async exists(fileId: string) {
    return (await this.bucket.head(fileId)) !== null
  }

  async stat(key: string) {
    const object = await this.bucket.head(key)
    return object
      ? {
          size: object.size,
          contentType: object.httpMetadata?.contentType ?? '',
        }
      : null
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor })
      keys.push(...page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return keys
  }
}

export function workerStorageFactory(env: WorkerEnv): StorageAdapterFactory {
  return (backend, bucket) => {
    const binding = env[bucketBindingName(bucket.name)] as
      | R2BucketLike
      | undefined
    const s3 = backend.type === 's3' ? new S3StorageAdapter(backend) : undefined
    if (binding) return new R2StorageAdapter(binding, s3)
    if (s3) return s3
    // The core builds an adapter for every resolved bucket at start, even the
    // implicit default one; fail on use, not on start.
    return missingBinding(bucket.name)
  }
}

function missingBinding(bucketName: string): StorageAdapter {
  const fail = async (): Promise<never> => {
    throw new Error(
      `[bunderstack] storage bucket "${bucketName}" needs the R2 binding ${bucketBindingName(bucketName)}`,
    )
  }
  return { upload: fail, get: fail, delete: fail, exists: fail }
}
