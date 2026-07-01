import { useRouteContext } from '@tanstack/react-router'
import * as React from 'react'

import type { UploadedFile } from 'bunderstack-sync'

export const ATTACHMENTS_BUCKET = 'attachments'
export const AVATARS_BUCKET = 'avatars'
/** Must match `defaultBucket` in `src/bunderstack.ts`. */
export const FILES_BUCKET = ATTACHMENTS_BUCKET

type UploadBucket = typeof ATTACHMENTS_BUCKET | typeof AVATARS_BUCKET
export type { UploadedFile }

/** Matches the path building in bunderstack-query's bucket client `url()` — a
 * pure function of bucket + fileId, so it doesn't need a live api instance. */
function encodeFilePath(idOrFileId: string): string {
  return idOrFileId
    .split('/')
    .map((segment) =>
      encodeURIComponent(decodeURIComponent(segment)).replace(/\./g, '%2E'),
    )
    .join('/')
}

function relativeId(bucket: UploadBucket, idOrFileId: string): string {
  const prefix = `${bucket}/`
  return idOrFileId.startsWith(prefix)
    ? idOrFileId.slice(prefix.length)
    : idOrFileId
}

export function thumbnailUrl(
  fileId: string,
  opts?: { w?: number; h?: number; format?: 'webp' | 'jpeg' },
) {
  const bucket: UploadBucket = fileId.startsWith(`${AVATARS_BUCKET}/`)
    ? AVATARS_BUCKET
    : ATTACHMENTS_BUCKET
  const params = new URLSearchParams()
  if (opts?.w !== undefined) params.set('w', String(opts.w))
  if (opts?.h !== undefined) params.set('h', String(opts.h))
  if (opts?.format) params.set('format', opts.format)
  const qs = params.toString()
  return `/api/files/${bucket}/${encodeFilePath(relativeId(bucket, fileId))}${qs ? `?${qs}` : ''}`
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
  const { api } = useRouteContext({ from: '__root__' })
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
            const uploaded = await api.files[bucket].upload(file)
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
