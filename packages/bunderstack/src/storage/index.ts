// src/storage/index.ts
import type { ResolvedStorage } from '../config.ts'
import { LocalStorageAdapter } from './local.ts'
import { S3StorageAdapter } from './s3.ts'

export type { LocalStorageAdapter, S3StorageAdapter }

export interface StorageAdapter {
  upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void>
  get(fileId: string): Promise<Response>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
}

export function createStorage(cfg: ResolvedStorage): StorageAdapter {
  if (cfg.type === 's3') {
    return new S3StorageAdapter({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      endpoint: cfg.endpoint,
    })
  }
  return new LocalStorageAdapter(cfg.path)
}
