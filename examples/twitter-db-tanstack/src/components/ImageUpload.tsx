import * as React from 'react'

import type { UploadedFile as BunderstackUploadedFile } from 'bunderstack-query'

import { filesApi } from '~/api-client'

export const ATTACHMENTS_BUCKET = 'attachments'
export const AVATARS_BUCKET = 'avatars'
/** Must match `defaultBucket` in `src/bunderstack.ts`. */
export const FILES_BUCKET = ATTACHMENTS_BUCKET

type UploadBucket = typeof ATTACHMENTS_BUCKET | typeof AVATARS_BUCKET
export type UploadedFile = BunderstackUploadedFile

export async function uploadFile(
  file: File,
  bucket: UploadBucket = ATTACHMENTS_BUCKET,
): Promise<UploadedFile> {
  return filesApi.files[bucket].upload(file)
}

export function thumbnailUrl(
  fileId: string,
  opts?: { w?: number; h?: number; format?: 'webp' | 'jpeg' },
) {
  const bucket = fileId.startsWith(`${AVATARS_BUCKET}/`)
    ? filesApi.files.avatars
    : filesApi.files.attachments
  return bucket.url(fileId, opts)
}

export function fileIdFromUrl(url: string | null | undefined): string | null {
  if (!url?.startsWith('/api/files/')) return null
  return url.replace('/api/files/', '').split('?')[0] ?? null
}

type ImageUploadProps = {
  label: string
  hint?: string
  accept?: string
  bucket?: UploadBucket
  onUploaded: (file: UploadedFile) => void | Promise<void>
  disabled?: boolean
}

export function ImageUpload({
  label,
  hint,
  accept = 'image/*',
  bucket = ATTACHMENTS_BUCKET,
  onUploaded,
  disabled,
}: ImageUploadProps) {
  const [status, setStatus] = React.useState<'idle' | 'uploading' | 'error'>(
    'idle',
  )
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase text-gray-400">
        {label}
      </div>
      {hint ? <p className="text-sm text-gray-500">{hint}</p> : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled || status === 'uploading'}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          setStatus('uploading')
          setError(null)
          try {
            const uploaded = await uploadFile(file, bucket)
            await onUploaded(uploaded)
            setStatus('idle')
          } catch (err) {
            setStatus('error')
            setError(err instanceof Error ? err.message : 'Upload failed')
          } finally {
            if (inputRef.current) inputRef.current.value = ''
          }
        }}
      />
      <button
        type="button"
        disabled={disabled || status === 'uploading'}
        onClick={() => inputRef.current?.click()}
      >
        {status === 'uploading' ? 'Uploading…' : 'Choose image'}
      </button>
      {error ? (
        <output data-variant="danger">
          <p>{error}</p>
        </output>
      ) : null}
    </div>
  )
}
