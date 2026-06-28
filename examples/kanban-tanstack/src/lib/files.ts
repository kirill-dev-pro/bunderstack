/** Must match `defaultBucket` in `src/bunderstack.ts`. */
export const FILES_BUCKET = 'attachments'

export type UploadedFile = {
  fileId: string
  url: string
  name: string
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData()
  form.append('file', file)

  const res = await fetch(`/api/files/${FILES_BUCKET}`, {
    method: 'POST',
    body: form,
    credentials: 'include',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      (err as { error?: string }).error ?? `Upload failed (${res.status})`,
    )
  }

  const { fileId, url } = (await res.json()) as { fileId: string; url: string }
  return { fileId, url, name: file.name }
}

export function thumbnailUrl(
  fileId: string,
  opts?: { w?: number; h?: number; format?: 'webp' | 'jpeg' },
) {
  const params = new URLSearchParams()
  if (opts?.w) params.set('w', String(opts.w))
  if (opts?.h) params.set('h', String(opts.h))
  if (opts?.format) params.set('format', opts.format)
  const qs = params.toString()
  return `/api/files/${fileId}${qs ? `?${qs}` : ''}`
}

export function fileIdFromUrl(url: string | null | undefined): string | null {
  if (!url?.startsWith('/api/files/')) return null
  return url.replace('/api/files/', '').split('?')[0] ?? null
}

export function isImageMime(mimeType: string | null | undefined) {
  return mimeType?.startsWith('image/') ?? false
}
