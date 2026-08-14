import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

import type { AccessContext, OperationRule } from '../access'
import type { AnyDb } from '../dialect'
import type { BucketStorageRegistry } from './registry'

import { checkAccess } from '../access'
import { BunderstackError } from '../errors'
import { deleteFileWithDerivatives } from './delete'
import {
  deleteFileMetaRow,
  fileMatchesScope,
  getFileMeta,
  insertPendingFile,
  insertReadyFile,
  markFileReady,
  scopeToJson,
  sumReadySize,
  type FileMetaRow,
} from './file-meta'
import { parseTransformSpec, transformHash, transformImage } from './thumbnails'

export interface StorageExecutionContext {
  request: Request
  user: AccessContext['user']
  session: { activeOrganizationId: string | null }
}

export interface StorageOperationsOptions {
  registry: BucketStorageRegistry
  db: AnyDb
  presignExpiresSec?: number
}

export type PrepareUploadResult =
  | { mode: 'proxy'; uploadUrl: string }
  | {
      mode: 'presign'
      fileId: string
      uploadUrl: string
      method: 'PUT'
      confirmUrl: string
    }

export type StorageDownload =
  | { kind: 'redirect'; status: 302; url: string }
  | {
      kind: 'body'
      status: number
      body: ConstructorParameters<typeof Response>[0]
      headers: Headers
    }

const FILE_OWNER_COLUMN = 'ownerId'

function matchMime(type: string, accept?: string[]): boolean {
  if (!accept || accept.length === 0) return true
  if (!type) return false
  return accept.some(
    (pattern) =>
      pattern === type ||
      (pattern.endsWith('/*') && type.startsWith(pattern.slice(0, -1))),
  )
}

function accessContext(
  context: StorageExecutionContext,
  extra: { row?: FileMetaRow; body?: Record<string, unknown> } = {},
): AccessContext {
  return {
    request: context.request,
    user: context.user,
    session: context.session,
    row: extra.row,
    body: extra.body,
  }
}

async function gate(rule: OperationRule, context: AccessContext) {
  const result = await checkAccess(rule, context, FILE_OWNER_COLUMN)
  if (!result.allowed) {
    throw new BunderstackError(
      result.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      result.status === 401 ? 'Authentication required' : 'Forbidden',
    )
  }
}

function notFound(message = 'Not found'): never {
  throw new BunderstackError('NOT_FOUND', message)
}

function sanitizeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '')
}

async function quotaExceeded(
  db: AnyDb,
  bucket: string,
  quota: { perUserBytes?: number; perScopeBytes?: number },
  ownerId: string | undefined,
  scopeJson: string | null,
  incoming: number,
): Promise<boolean> {
  if (quota.perUserBytes !== undefined && ownerId !== undefined) {
    const current = await sumReadySize(db, { bucket, ownerId })
    if (current + incoming > quota.perUserBytes) return true
  }
  if (quota.perScopeBytes !== undefined && scopeJson != null) {
    const current = await sumReadySize(db, { bucket, scopeJson })
    if (current + incoming > quota.perScopeBytes) return true
  }
  return false
}

export function createStorageOperations(options: StorageOperationsOptions) {
  const { registry, db } = options
  const presignExpiresSec = options.presignExpiresSec ?? 60

  const bucketEntry = (name: string) => {
    const entry = registry.get(name)
    if (!entry) notFound('Unknown bucket')
    return entry
  }

  return {
    async prepareUpload(
      bucketName: string,
      body: { filename?: string; contentType?: string },
      context: StorageExecutionContext,
    ): Promise<PrepareUploadResult> {
      const { bucket, adapter } = bucketEntry(bucketName)
      const ctx = accessContext(context, { body })
      await gate(bucket.access.create, ctx)

      if (!adapter.presignPut) {
        return { mode: 'proxy', uploadUrl: `/api/files/${bucket.name}` }
      }

      const scopeJson = scopeToJson(bucket.writeScope?.(ctx))
      if (
        bucket.quota &&
        (await quotaExceeded(
          db,
          bucket.name,
          bucket.quota,
          context.user?.id,
          scopeJson,
          bucket.upload?.maxSizeBytes ?? 0,
        ))
      ) {
        throw new BunderstackError('PAYLOAD_TOO_LARGE', 'Quota exceeded')
      }

      const fileId = `${bucket.name}/${randomUUID()}${extname(body.filename ?? '')}`
      await insertPendingFile(db, {
        fileId,
        bucket: bucket.name,
        ownerId: context.user?.id ?? null,
        scopeJson,
        filename: body.filename ?? null,
        contentType: body.contentType ?? null,
      })
      const uploadUrl = await adapter.presignPut(fileId, {
        contentType: body.contentType,
        expiresIn: presignExpiresSec,
      })
      const id = fileId.slice(`${bucket.name}/`.length)
      return {
        mode: 'presign',
        fileId,
        uploadUrl,
        method: 'PUT',
        confirmUrl: `/api/files/${bucket.name}/${id}/confirm`,
      }
    },

    async upload(
      bucketName: string,
      file: File,
      context: StorageExecutionContext,
    ) {
      const { bucket, adapter } = bucketEntry(bucketName)
      const ctx = accessContext(context)
      await gate(bucket.access.create, ctx)

      if (!matchMime(file.type, bucket.upload?.accept)) {
        throw new BunderstackError(
          'BAD_REQUEST',
          `Content type ${file.type || '(none)'} not allowed`,
        )
      }
      if (
        bucket.upload?.maxSizeBytes !== undefined &&
        file.size > bucket.upload.maxSizeBytes
      ) {
        throw new BunderstackError('PAYLOAD_TOO_LARGE', 'File too large')
      }

      const scopeJson = scopeToJson(bucket.readScope?.(ctx))
      if (
        bucket.quota &&
        (await quotaExceeded(
          db,
          bucket.name,
          bucket.quota,
          context.user?.id,
          scopeJson,
          file.size,
        ))
      ) {
        throw new BunderstackError('PAYLOAD_TOO_LARGE', 'Quota exceeded')
      }

      const fileId = `${bucket.name}/${randomUUID()}${extname(file.name)}`
      await adapter.upload(fileId, await file.arrayBuffer(), file.type)
      await insertReadyFile(db, {
        fileId,
        bucket: bucket.name,
        ownerId: context.user?.id ?? null,
        scopeJson,
        filename: file.name || null,
        contentType: file.type || null,
        size: file.size,
      })
      const id = fileId.slice(`${bucket.name}/`.length)
      return {
        status: 201 as const,
        fileId,
        url: `/api/files/${bucket.name}/${id}`,
      }
    },

    async confirmUpload(
      bucketName: string,
      id: string,
      context: StorageExecutionContext,
    ) {
      const { bucket, adapter } = bucketEntry(bucketName)
      const fileId = `${bucketName}/${id}`
      const row = await getFileMeta(db, fileId)
      if (!row || row.bucket !== bucketName) notFound()
      if (row.ownerId != null && row.ownerId !== (context.user?.id ?? null)) {
        throw new BunderstackError('FORBIDDEN', 'Forbidden')
      }

      const result = { fileId, url: `/api/files/${bucketName}/${id}` }
      if (row.status === 'ready') return result

      const info = await adapter.stat?.(fileId)
      if (!info) notFound()

      const rejectUpload = async (message: string, validation = false) => {
        await adapter.delete(fileId)
        await deleteFileMetaRow(db, fileId)
        throw new BunderstackError(
          validation ? 'BAD_REQUEST' : 'PAYLOAD_TOO_LARGE',
          message,
        )
      }
      if (
        bucket.upload?.maxSizeBytes !== undefined &&
        info.size > bucket.upload.maxSizeBytes
      ) {
        await rejectUpload('File too large')
      }
      if (!matchMime(info.contentType, bucket.upload?.accept)) {
        await rejectUpload(
          `Content type ${info.contentType || '(none)'} not allowed`,
          true,
        )
      }
      if (
        bucket.quota &&
        (await quotaExceeded(
          db,
          bucket.name,
          bucket.quota,
          row.ownerId ?? undefined,
          row.scopeJson,
          info.size,
        ))
      ) {
        await rejectUpload('Quota exceeded')
      }

      await markFileReady(db, fileId, info)
      return result
    },

    async download(
      bucketName: string,
      id: string,
      query: Record<string, string>,
      context: StorageExecutionContext,
    ): Promise<StorageDownload> {
      const { bucket, adapter } = bucketEntry(bucketName)
      const fileId = `${bucketName}/${id}`
      const row = await getFileMeta(db, fileId)
      if (!row || row.status !== 'ready' || row.bucket !== bucketName)
        notFound()

      const ctx = accessContext(context, { row })
      await gate(bucket.access.get, ctx)
      if (!fileMatchesScope(row, bucket.readScope?.(ctx))) notFound()

      const spec = parseTransformSpec(query)
      if (spec) {
        if (!bucket.transforms) {
          throw new BunderstackError(
            'BAD_REQUEST',
            'Transforms not enabled for this bucket',
          )
        }
        const ext = spec.format ? `.${spec.format}` : extname(fileId) || '.jpg'
        const cacheKey = `${fileId}__transforms/${transformHash(spec)}${ext}`
        if (await adapter.exists(cacheKey)) {
          const cached = await adapter.get(cacheKey)
          const headers = new Headers(cached.headers)
          headers.set('Cache-Control', 'public, max-age=31536000')
          return {
            kind: 'body',
            status: cached.status,
            body: cached.body,
            headers,
          }
        }

        const original = await adapter.get(fileId)
        if (original.status === 404) notFound()
        const transformed = await transformImage(
          Buffer.from(await original.arrayBuffer()),
          spec,
        )
        const contentType = spec.format
          ? `image/${spec.format}`
          : (original.headers.get('Content-Type') ?? 'image/jpeg')
        const body = Uint8Array.from(transformed).buffer
        await adapter.upload(cacheKey, body, contentType)
        return {
          kind: 'body',
          status: 200,
          body,
          headers: new Headers({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000',
          }),
        }
      }

      if (bucket.visibility === 'public' && adapter.publicUrlFor) {
        const url = adapter.publicUrlFor(fileId)
        if (url) return { kind: 'redirect', status: 302, url }
      }
      if (bucket.visibility === 'private' && adapter.presignGet) {
        return {
          kind: 'redirect',
          status: 302,
          url: await adapter.presignGet(fileId, {
            expiresIn: presignExpiresSec,
          }),
        }
      }

      const response = await adapter.get(fileId)
      const headers = new Headers(response.headers)
      if (response.status !== 404 && row.filename) {
        headers.set(
          'Content-Disposition',
          `inline; filename="${sanitizeFilename(row.filename)}"`,
        )
      }
      return {
        kind: 'body',
        status: response.status,
        body: response.body,
        headers,
      }
    },

    async delete(
      bucketName: string,
      id: string,
      context: StorageExecutionContext,
    ): Promise<void> {
      const { bucket, adapter } = bucketEntry(bucketName)
      const fileId = `${bucketName}/${id}`
      const row = await getFileMeta(db, fileId)
      if (!row || row.bucket !== bucketName) notFound()
      const ctx = accessContext(context, { row })
      await gate(bucket.access.delete, ctx)
      if (!fileMatchesScope(row, bucket.readScope?.(ctx))) notFound()
      await deleteFileWithDerivatives(adapter, db, fileId)
    },
  }
}

export type StorageOperations = ReturnType<typeof createStorageOperations>
