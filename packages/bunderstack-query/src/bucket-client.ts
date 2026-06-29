import type { QueryClient, UseMutationOptions } from '@tanstack/react-query'

import { BunderstackApiError } from './errors.ts'

export type UploadedFile = {
  fileId: string
  url: string
  name: string
}

export type UploadMode = 'auto' | 'proxy' | 'presign'

export type UploadOptions = {
  mode?: UploadMode
}

export type FileTransformOptions = {
  w?: number
  h?: number
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
}

export type BucketClientConfig = {
  bucket: string
  baseUrl: string
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

type PresignResponse =
  | {
      mode: 'proxy'
      uploadUrl: string
    }
  | {
      mode: 'presign'
      fileId: string
      uploadUrl: string
      method?: string
      confirmUrl: string
    }

async function parseError(res: Response): Promise<BunderstackApiError> {
  const body = await res.json().catch(() => ({}))
  const message =
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof body.error === 'string'
      ? body.error
      : `Request failed (${res.status})`
  return new BunderstackApiError(message, res.status, body)
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await parseError(res)
  return res.json() as Promise<T>
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

function relativeId(bucket: string, idOrFileId: string): string {
  const prefix = `${bucket}/`
  return idOrFileId.startsWith(prefix)
    ? idOrFileId.slice(prefix.length)
    : idOrFileId
}

function encodeFilePath(idOrFileId: string): string {
  return idOrFileId
    .split('/')
    .map((segment) =>
      encodeURIComponent(decodeURIComponent(segment)).replace(/\./g, '%2E'),
    )
    .join('/')
}

function fileUrl(root: string, bucket: string, idOrFileId: string): string {
  return `${root}/${encodeFilePath(relativeId(bucket, idOrFileId))}`
}

function contentTypeHeader(file: File): HeadersInit | undefined {
  return file.type ? { 'Content-Type': file.type } : undefined
}

export function createBucketClient(config: BucketClientConfig) {
  const { bucket, fetch: fetchFn } = config
  const apiRoot = `${trimBaseUrl(config.baseUrl)}/files/${bucket}`
  const keys = {
    all: ['files', bucket] as const,
  }

  async function proxyUpload(file: File): Promise<UploadedFile> {
    const body = new FormData()
    body.append('file', file)
    const res = await fetchFn(apiRoot, {
      method: 'POST',
      body,
      credentials: 'include',
    })
    const uploaded = await readJson<{ fileId: string; url: string }>(res)
    return { ...uploaded, url: url(uploaded.fileId), name: file.name }
  }

  async function presignUpload(file: File): Promise<UploadedFile> {
    const presignRes = await fetchFn(`${apiRoot}/presign`, {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || undefined,
      }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    const presign = await readJson<PresignResponse>(presignRes)
    if (presign.mode === 'proxy') return proxyUpload(file)

    const uploadRes = await fetchFn(presign.uploadUrl, {
      method: presign.method ?? 'PUT',
      body: file,
      headers: contentTypeHeader(file),
    })
    if (!uploadRes.ok) throw await parseError(uploadRes)

    const confirmRes = await fetchFn(`${url(presign.fileId)}/confirm`, {
      method: 'POST',
      credentials: 'include',
    })
    const uploaded = await readJson<{ fileId: string; url: string }>(confirmRes)
    return { ...uploaded, url: url(uploaded.fileId), name: file.name }
  }

  const upload = (file: File, options: UploadOptions = {}) =>
    options.mode === 'presign' ? presignUpload(file) : proxyUpload(file)

  const deleteFile = async (idOrFileId: string): Promise<void> => {
    const res = await fetchFn(fileUrl(apiRoot, bucket, idOrFileId), {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) throw await parseError(res)
  }

  const url = (
    idOrFileId: string,
    transforms: FileTransformOptions = {},
  ): string => {
    const params = new URLSearchParams()
    if (transforms.w !== undefined) params.set('w', String(transforms.w))
    if (transforms.h !== undefined) params.set('h', String(transforms.h))
    if (transforms.format) params.set('format', transforms.format)
    const qs = params.toString()
    return `${fileUrl(apiRoot, bucket, idOrFileId)}${qs ? `?${qs}` : ''}`
  }

  return {
    keys,
    upload,
    delete: deleteFile,
    url,
  }
}

export type BucketClient = ReturnType<typeof createBucketClient>

export type BucketMutationOptions = {
  uploadMutation: (
    options?: Omit<
      UseMutationOptions<UploadedFile, Error, File, unknown>,
      'mutationFn'
    >,
  ) => UseMutationOptions<UploadedFile, Error, File, unknown>
  deleteMutation: (
    options?: Omit<
      UseMutationOptions<void, Error, string, unknown>,
      'mutationFn'
    >,
  ) => UseMutationOptions<void, Error, string, unknown>
}

export function attachBucketMutationOptions(
  bucketClient: BucketClient,
  queryClient?: QueryClient,
): BucketMutationOptions {
  const invalidate = () => {
    if (queryClient)
      void queryClient.invalidateQueries({ queryKey: bucketClient.keys.all })
  }

  return {
    uploadMutation(options = {}) {
      const { onSuccess, ...rest } = options
      return {
        mutationFn: (file: File) => bucketClient.upload(file),
        onSuccess: (data, variables, context, mutation) => {
          invalidate()
          onSuccess?.(data, variables, context, mutation)
        },
        ...rest,
      }
    },
    deleteMutation(options = {}) {
      const { onSuccess, ...rest } = options
      return {
        mutationFn: (id: string) => bucketClient.delete(id),
        onSuccess: (data, variables, context, mutation) => {
          invalidate()
          onSuccess?.(data, variables, context, mutation)
        },
        ...rest,
      }
    },
  }
}
