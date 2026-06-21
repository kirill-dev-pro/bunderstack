// src/storage/index.ts
import type { ResolvedStorage } from '../config'
import { LocalStorageAdapter } from './local'

export type { LocalStorageAdapter }

export interface StorageAdapter {
  upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void>
  get(fileId: string): Promise<Response>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
}

export function createStorage(cfg: ResolvedStorage): StorageAdapter {
  if (cfg.type === 's3') {
    // S3 adapter wired in Task 8
    throw new Error('S3 storage adapter not yet implemented — set storage: { local: true }')
  }
  return new LocalStorageAdapter(cfg.path)
}
