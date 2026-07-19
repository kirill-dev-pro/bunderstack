// src/storage/router.ts
import type { Context } from 'hono'

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

import type {
  AccessContext,
  AuthSessionResolver,
  OperationRule,
} from '../access'
import type { AnyDb } from '../dialect'
import type { BucketStorageRegistry } from './registry'

import { checkAccess, resolveSession } from '../access'
import { ErrorCode, apiError } from '../errors'
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

export interface BucketStorageRouterOptions {
  registry: BucketStorageRegistry
  db: AnyDb
  auth: AuthSessionResolver | undefined
  /** Default presign TTL (seconds) for PUT/GET URLs. */
  presignExpiresSec?: number
}

const FILE_OWNER_COLUMN = 'ownerId'

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wildcard-aware MIME match. No accept list → always true. Matches an exact
 * type or a `prefix/*` wildcard (e.g. `image/*`). An empty `type` fails a
 * non-empty accept list.
 */
function matchMime(type: string, accept?: string[]): boolean {
  if (!accept || accept.length === 0) return true
  if (!type) return false
  for (const pattern of accept) {
    if (pattern === type) return true
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1) // keep trailing slash, e.g. "image/"
      if (type.startsWith(prefix)) return true
    }
  }
  return false
}

/**
 * Run an access rule. Returns the apiError Response when denied (401 if the
 * rule failed for lack of a session, else 403), or null when allowed.
 */
async function gate(
  rule: OperationRule,
  ctx: AccessContext,
  c: Context,
): Promise<Response | null> {
  const result = await checkAccess(rule, ctx, FILE_OWNER_COLUMN)
  if (result.allowed) return null
  return apiError(
    c,
    ErrorCode.FORBIDDEN,
    'Forbidden',
    result.status === 401 ? 401 : 403,
  )
}

/** Build the AccessContext for a request. */
function buildCtx(
  c: Context,
  user: AccessContext['user'],
  activeOrganizationId: string | null,
  extra: { row?: FileMetaRow; body?: Record<string, unknown> } = {},
): AccessContext {
  return {
    user,
    request: c.req.raw,
    row: extra.row,
    body: extra.body,
    session: { activeOrganizationId },
  }
}

/** Strip dangerous quote chars from a filename used in a header. */
function sanitizeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function buildBucketStorageRouter(
  opts: BucketStorageRouterOptions,
): Hono {
  const { registry, db, auth } = opts
  const presignExpiresSec = opts.presignExpiresSec ?? 60
  const router = new Hono()

  // DECISION — upload path is auto-selected by backend capability, not a user
  // toggle. Presign-capable backends (S3, R2) advertise `presignPut`, so
  // `POST /:bucket/presign` returns `mode:'presign'`: the client PUTs bytes
  // directly to object storage, which avoids buffering the whole file in app
  // memory and offloads upload bandwidth from the app server. Backends without
  // presign (local/dev) return `mode:'proxy'` so `POST /:bucket` (the
  // proxy-upload route below) works with zero setup — at the cost of loading
  // the whole file into memory (see the `file.arrayBuffer()` call there). The
  // two-phase presign flow (presign → direct PUT → confirm) intentionally
  // leaves `pending` rows; the T6 orphan sweep reaps any that never confirm.
  // If two-phase proves too fragile in practice the fallback is presign-only
  // (design model B) — do NOT collapse the dual path here. See design §5.

  // ─── POST /:bucket/presign — upload init / auto-selection ─────────────────
  router.post('/:bucket/presign', async (c) => {
    const entry = registry.get(c.req.param('bucket'))
    if (!entry) return apiError(c, ErrorCode.NOT_FOUND, 'Unknown bucket', 404)
    const { bucket, adapter } = entry

    const { user, activeOrganizationId } = await resolveSession(
      auth,
      c.req.raw.headers,
    )

    let body: Record<string, unknown> = {}
    try {
      const parsed = await c.req.json()
      if (isRecord(parsed)) body = parsed
    } catch {
      body = {}
    }

    const ctx = buildCtx(c, user, activeOrganizationId, { body })
    const denied = await gate(bucket.access.create, ctx, c)
    if (denied) return denied

    // No presign capability (e.g. local) → tell client to proxy-upload.
    if (!adapter.presignPut) {
      return c.json(
        { mode: 'proxy', uploadUrl: `/api/files/${bucket.name}` },
        200,
      )
    }

    const filename =
      typeof body.filename === 'string' ? body.filename : undefined
    const contentType =
      typeof body.contentType === 'string' ? body.contentType : undefined

    const requesterScope = bucket.writeScope?.(ctx)
    const scopeJson = scopeToJson(requesterScope)

    // Quota pre-check: reserve the configured max upload size.
    if (bucket.quota) {
      const reservation = bucket.upload?.maxSizeBytes ?? 0
      const over = await quotaExceeded(
        db,
        bucket.name,
        bucket.quota,
        user?.id,
        scopeJson,
        reservation,
      )
      if (over) {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Quota exceeded', 413)
      }
    }

    const fileId = `${bucket.name}/${randomUUID()}${extname(filename ?? '')}`
    await insertPendingFile(db, {
      fileId,
      bucket: bucket.name,
      ownerId: user?.id ?? null,
      scopeJson,
      filename: filename ?? null,
      contentType: contentType ?? null,
    })

    const uploadUrl = await adapter.presignPut(fileId, {
      contentType,
      expiresIn: presignExpiresSec,
    })
    const id = fileId.slice(`${bucket.name}/`.length)

    return c.json(
      {
        mode: 'presign',
        fileId,
        uploadUrl,
        method: 'PUT',
        confirmUrl: `/api/files/${bucket.name}/${id}/confirm`,
      },
      200,
    )
  })

  // ─── POST /:bucket — proxy upload ─────────────────────────────────────────
  router.post('/:bucket', async (c) => {
    const entry = registry.get(c.req.param('bucket'))
    if (!entry) return apiError(c, ErrorCode.NOT_FOUND, 'Unknown bucket', 404)
    const { bucket, adapter } = entry

    const { user, activeOrganizationId } = await resolveSession(
      auth,
      c.req.raw.headers,
    )
    const ctx = buildCtx(c, user, activeOrganizationId)
    const denied = await gate(bucket.access.create, ctx, c)
    if (denied) return denied

    const parsed = await c.req.parseBody()
    const file = parsed['file']
    if (!(file instanceof File)) {
      return apiError(
        c,
        ErrorCode.VALIDATION_ERROR,
        'No file field in request',
        400,
      )
    }

    if (bucket.upload?.accept && !matchMime(file.type, bucket.upload.accept)) {
      return apiError(
        c,
        ErrorCode.VALIDATION_ERROR,
        `Content type ${file.type || '(none)'} not allowed`,
        422,
      )
    }
    if (
      bucket.upload?.maxSizeBytes !== undefined &&
      file.size > bucket.upload.maxSizeBytes
    ) {
      return apiError(c, ErrorCode.VALIDATION_ERROR, 'File too large', 422)
    }

    const requesterScope = bucket.readScope?.(ctx)
    const scopeJson = scopeToJson(requesterScope)

    if (bucket.quota) {
      const over = await quotaExceeded(
        db,
        bucket.name,
        bucket.quota,
        user?.id,
        scopeJson,
        file.size,
      )
      if (over) {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Quota exceeded', 413)
      }
    }

    const fileId = `${bucket.name}/${randomUUID()}${extname(file.name)}`
    // NOTE: this loads the whole file into app memory — exactly why presign
    // exists for capable backends (see the DECISION block above).
    await adapter.upload(fileId, await file.arrayBuffer(), file.type)
    await insertReadyFile(db, {
      fileId,
      bucket: bucket.name,
      ownerId: user?.id ?? null,
      scopeJson,
      filename: file.name || null,
      contentType: file.type || null,
      size: file.size,
    })

    const id = fileId.slice(`${bucket.name}/`.length)
    return c.json({ fileId, url: `/api/files/${bucket.name}/${id}` }, 201)
  })

  // ─── POST /:bucket/:id/confirm ────────────────────────────────────────────
  router.post('/:bucket/:id/confirm', async (c) => {
    const bucketName = c.req.param('bucket')
    const entry = registry.get(bucketName)
    if (!entry) return apiError(c, ErrorCode.NOT_FOUND, 'Unknown bucket', 404)
    const { bucket, adapter } = entry

    const id = c.req.param('id')
    const fileId = `${bucketName}/${id}`

    const { user } = await resolveSession(auth, c.req.raw.headers)

    const row = await getFileMeta(db, fileId)
    if (!row || row.bucket !== bucketName) {
      return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
    }

    // ownerId-only gate: confirm finalizes a pending upload, so it only checks
    // that the caller owns the row (matching who presigned it). The full
    // `access.create`/`get` rules ran at presign and run again on read.
    if (row.ownerId != null && row.ownerId !== (user?.id ?? null)) {
      return apiError(c, ErrorCode.FORBIDDEN, 'Forbidden', 403)
    }

    const url = `/api/files/${bucketName}/${id}`

    // Idempotent: already confirmed.
    if (row.status === 'ready') {
      return c.json({ fileId, url }, 200)
    }

    const info = await adapter.stat?.(fileId)
    if (info == null) {
      return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
    }

    if (
      bucket.upload?.maxSizeBytes !== undefined &&
      info.size > bucket.upload.maxSizeBytes
    ) {
      await adapter.delete(fileId)
      await deleteFileMetaRow(db, fileId)
      return apiError(c, ErrorCode.VALIDATION_ERROR, 'File too large', 413)
    }
    if (
      bucket.upload?.accept &&
      !matchMime(info.contentType, bucket.upload.accept)
    ) {
      await adapter.delete(fileId)
      await deleteFileMetaRow(db, fileId)
      return apiError(
        c,
        ErrorCode.VALIDATION_ERROR,
        `Content type ${info.contentType || '(none)'} not allowed`,
        422,
      )
    }

    // Quota reconciliation: presign reserved the worst-case `maxSize`; now we
    // know the real size. The pending row isn't counted by `sumReadySize`
    // (ready-only), so this compares existing usage + the actual bytes.
    if (bucket.quota) {
      const over = await quotaExceeded(
        db,
        bucket.name,
        bucket.quota,
        row.ownerId ?? undefined,
        row.scopeJson,
        info.size,
      )
      if (over) {
        await adapter.delete(fileId)
        await deleteFileMetaRow(db, fileId)
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Quota exceeded', 413)
      }
    }

    await markFileReady(db, fileId, {
      size: info.size,
      contentType: info.contentType,
    })
    return c.json({ fileId, url }, 200)
  })

  // ─── GET /:bucket/:id ─────────────────────────────────────────────────────
  router.get('/:bucket/:id', async (c) => {
    const bucketName = c.req.param('bucket')
    const entry = registry.get(bucketName)
    if (!entry) return apiError(c, ErrorCode.NOT_FOUND, 'Unknown bucket', 404)
    const { bucket, adapter } = entry

    const id = c.req.param('id')
    const fileId = `${bucketName}/${id}`

    const row = await getFileMeta(db, fileId)
    if (!row || row.status !== 'ready' || row.bucket !== bucketName) {
      return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
    }

    const { user, activeOrganizationId } = await resolveSession(
      auth,
      c.req.raw.headers,
    )
    const ctx = buildCtx(c, user, activeOrganizationId, { row })

    const denied = await gate(bucket.access.get, ctx, c)
    if (denied) return denied

    const requesterScope = bucket.readScope?.(ctx)
    if (!fileMatchesScope(row, requesterScope)) {
      return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
    }

    const spec = parseTransformSpec(c.req.query())
    if (spec) {
      if (!bucket.transforms) {
        return apiError(
          c,
          ErrorCode.VALIDATION_ERROR,
          'Transforms not enabled for this bucket',
          400,
        )
      }
      // Proxy-transform path regardless of visibility (we must read + write
      // bytes through the app). Mirrors the legacy on-the-fly transform logic.
      const ext = spec.format ? `.${spec.format}` : extname(fileId) || '.jpg'
      const cacheKey = `${fileId}__transforms/${transformHash(spec)}${ext}`

      if (await adapter.exists(cacheKey)) {
        const cached = await adapter.get(cacheKey)
        // Re-attach caching headers so cached derivatives match fresh serves
        // (the adapter may not preserve Cache-Control on read).
        const headers = new Headers(cached.headers)
        headers.set('Cache-Control', 'public, max-age=31536000')
        return new Response(cached.body, { status: cached.status, headers })
      }

      const original = await adapter.get(fileId)
      if (original.status === 404) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      const inputBuffer = Buffer.from(await original.clone().arrayBuffer())
      const transformed = await transformImage(inputBuffer, spec)
      const contentType = spec.format
        ? `image/${spec.format}`
        : (original.headers.get('Content-Type') ?? 'image/jpeg')
      const transformedAb = Uint8Array.from(transformed).buffer
      await adapter.upload(cacheKey, transformedAb, contentType)
      return new Response(transformedAb, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000',
        },
      })
    }

    // No spec — serve by visibility.
    if (bucket.visibility === 'public' && adapter.publicUrlFor) {
      const url = adapter.publicUrlFor(fileId)
      if (url) return c.redirect(url, 302)
    }
    if (bucket.visibility === 'private' && adapter.presignGet) {
      const url = await adapter.presignGet(fileId, {
        expiresIn: presignExpiresSec,
      })
      return c.redirect(url, 302)
    }

    // Proxy fallback (e.g. local).
    const res = await adapter.get(fileId)
    if (res.status === 404 || !row.filename) return res
    const headers = new Headers(res.headers)
    headers.set(
      'Content-Disposition',
      `inline; filename="${sanitizeFilename(row.filename)}"`,
    )
    return new Response(res.body, { status: res.status, headers })
  })

  // ─── DELETE /:bucket/:id ──────────────────────────────────────────────────
  router.delete('/:bucket/:id', async (c) => {
    const bucketName = c.req.param('bucket')
    const entry = registry.get(bucketName)
    if (!entry) return apiError(c, ErrorCode.NOT_FOUND, 'Unknown bucket', 404)
    const { bucket, adapter } = entry

    const id = c.req.param('id')
    const fileId = `${bucketName}/${id}`

    const row = await getFileMeta(db, fileId)
    if (!row || row.bucket !== bucketName) {
      return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
    }

    const { user, activeOrganizationId } = await resolveSession(
      auth,
      c.req.raw.headers,
    )
    const ctx = buildCtx(c, user, activeOrganizationId, { row })

    const denied = await gate(bucket.access.delete, ctx, c)
    if (denied) return denied

    const requesterScope = bucket.readScope?.(ctx)
    if (!fileMatchesScope(row, requesterScope)) {
      return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
    }

    // Removes the original, any transform-cache derivatives, and the meta row.
    await deleteFileWithDerivatives(adapter, db, fileId)
    return new Response(null, { status: 204 })
  })

  return router
}

// ─── Quota helper ─────────────────────────────────────────────────────────────

/**
 * Returns true when adding `incoming` bytes would breach any configured quota
 * dimension (perUser uses ownerId; perScope uses scopeJson).
 */
async function quotaExceeded(
  db: AnyDb,
  bucket: string,
  quota: { perUserBytes?: number; perScopeBytes?: number },
  ownerId: string | undefined,
  scopeJson: string | null,
  incoming: number,
): Promise<boolean> {
  // Anonymous uploads (no ownerId) aren't attributed to a per-user bucket, so
  // they intentionally bypass `perUser` here. `perScope` (below) still applies.
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
