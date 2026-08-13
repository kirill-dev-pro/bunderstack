import type { QueryClient } from '@tanstack/react-query'

import type { ApiQueryUtils } from './api'
import type {
  AnyBunderstackApp,
  InferApiRouter,
  InferBuckets,
} from './infer'

import { createApiClient } from './api'
import { createFetch, type TransportFetch } from './fetch'

export type ClientOptions = {
  baseUrl?: string
  fetch?: TransportFetch
  queryClient?: QueryClient
}

export type FileTransformOptions = {
  w?: number
  h?: number
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
}

export type UploadedFile = {
  fileId: string
  url: string
  name: string
}

export type FileBucketHelpers = {
  url(idOrFileId: string, transforms?: FileTransformOptions): string
  upload(file: File): Promise<UploadedFile>
  delete(idOrFileId: string): Promise<void>
}

type FileHelpers<TBuckets extends string> = {
  files: { [K in TBuckets]: FileBucketHelpers }
}

export type BunderstackClient<TApp extends AnyBunderstackApp> =
  ApiQueryUtils<InferApiRouter<TApp>> & FileHelpers<InferBuckets<TApp>>

function trimSlash(value: string): string {
  return value.replace(/\/$/, '')
}

function relativeId(bucket: string, idOrFileId: string): string {
  const prefix = `${bucket}/`
  return idOrFileId.startsWith(prefix)
    ? idOrFileId.slice(prefix.length)
    : idOrFileId
}

function encodeFilePath(value: string): string {
  return value
    .split('/')
    .map((segment) =>
      encodeURIComponent(decodeURIComponent(segment)).replace(/\./g, '%2E'),
    )
    .join('/')
}

function attachFileHelpers<T extends object>(
  utils: T,
  options: ClientOptions,
): T {
  const baseUrl = trimSlash(options.baseUrl ?? '/api')
  const fetch = createFetch(options.fetch)
  const files = (utils as Record<string, unknown>)['files'] as
    | Record<string, unknown>
    | undefined
  if (!files) return utils

  const buckets = new Map<string, unknown>()
  const filesProxy = new Proxy(files, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      const cached = buckets.get(property)
      if (cached) return cached

      const procedures = Reflect.get(target, property, receiver) as Record<
        string,
        { call(input: unknown): Promise<any> }
      >
      const root = `${baseUrl}/files/${property}`
      const url = (
        idOrFileId: string,
        transforms: FileTransformOptions = {},
      ) => {
        const path = encodeFilePath(relativeId(property, idOrFileId))
        const params = new URLSearchParams()
        if (transforms.w !== undefined) params.set('w', String(transforms.w))
        if (transforms.h !== undefined) params.set('h', String(transforms.h))
        if (transforms.format) params.set('format', transforms.format)
        const query = params.toString()
        return `${root}/${path}${query ? `?${query}` : ''}`
      }
      const upload = async (file: File): Promise<UploadedFile> => {
        const prepared = await procedures.prepareUpload!.call({
          filename: file.name,
          contentType: file.type || undefined,
        })
        if (prepared.mode === 'proxy') {
          const result = await procedures.upload!.call({
            params: {},
            query: {},
            headers: {},
            body: { file },
          })
          return {
            ...result.body,
            url: url(result.body.fileId),
            name: file.name,
          }
        }

        const uploaded = await fetch(prepared.uploadUrl, {
          method: prepared.method,
          body: file,
          headers: file.type ? { 'Content-Type': file.type } : undefined,
        })
        if (!uploaded.ok) {
          throw new Error(`File upload failed (${uploaded.status})`)
        }
        const result = await procedures.confirmUpload!.call({ id: prepared.fileId })
        return { ...result, url: url(result.fileId), name: file.name }
      }

      const deleteFile = (idOrFileId: string) =>
        procedures.delete!.call({ path: relativeId(property, idOrFileId) })

      const bucket = Object.assign(Object.create(procedures), {
        url,
        upload,
        delete: deleteFile,
      })
      buckets.set(property, bucket)
      return bucket
    },
  })

  return new Proxy(utils, {
    get(target, property, receiver) {
      return property === 'files'
        ? filesProxy
        : Reflect.get(target, property, receiver)
    },
  })
}

export function createClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): BunderstackClient<TApp> {
  return attachFileHelpers(
    createApiClient<InferApiRouter<TApp>>(options),
    options,
  ) as BunderstackClient<TApp>
}
