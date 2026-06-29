import type { UploadedFile } from 'bunderstack-query'

import { api } from '~/api-client'

export const ATTACHMENTS_BUCKET = 'attachments'
export const AVATARS_BUCKET = 'avatars'
/** Must match `defaultBucket` in `src/bunderstack.ts`. */
export const FILES_BUCKET = ATTACHMENTS_BUCKET

export async function uploadFile(file: File): Promise<UploadedFile> {
  return api.files.attachments.upload(file)
}

export async function uploadAvatar(file: File): Promise<UploadedFile> {
  return api.files.avatars.upload(file)
}

export function thumbnailUrl(
  fileId: string,
  opts?: { w?: number; h?: number; format?: 'webp' | 'jpeg' },
) {
  const bucket = fileId.startsWith(`${AVATARS_BUCKET}/`)
    ? api.files.avatars
    : api.files.attachments
  return bucket.url(fileId, opts)
}

export function fileIdFromUrl(url: string | null | undefined): string | null {
  if (!url?.startsWith('/api/files/')) return null
  return url.replace('/api/files/', '').split('?')[0] ?? null
}

export function isImageMime(mimeType: string | null | undefined) {
  return mimeType?.startsWith('image/') ?? false
}
