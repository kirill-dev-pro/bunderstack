// src/storage/index.ts
import { LocalStorageAdapter } from './local.ts'
import { S3StorageAdapter } from './s3.ts'

export type { LocalStorageAdapter, S3StorageAdapter }

export interface PresignPutOptions { contentType?: string; expiresIn: number }
export interface PresignGetOptions { expiresIn: number }

export interface StorageAdapter {
  upload(
    fileId: string,
    data: Blob | ArrayBuffer,
    contentType: string,
  ): Promise<void>
  get(fileId: string): Promise<Response>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
  // Optional — present on S3, absent on local (router uses proxy path for local)
  presignPut?(key: string, opts: PresignPutOptions): Promise<string>
  presignGet?(key: string, opts: PresignGetOptions): Promise<string>
  stat?(key: string): Promise<{ size: number; contentType: string } | null>
  publicUrlFor?(key: string): string | undefined
  /** List full object keys under a prefix (used to reap transform derivatives). */
  list?(prefix: string): Promise<string[]>
}
