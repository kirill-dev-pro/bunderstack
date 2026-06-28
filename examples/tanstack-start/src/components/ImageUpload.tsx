import * as React from 'react'

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

type ImageUploadProps = {
  label: string
  hint?: string
  accept?: string
  onUploaded: (file: UploadedFile) => void | Promise<void>
  disabled?: boolean
}

export function ImageUpload({
  label,
  hint,
  accept = 'image/*',
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
            const uploaded = await uploadFile(file)
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
