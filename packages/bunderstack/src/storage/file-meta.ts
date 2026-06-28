/*
 * DEFERRED — logical/physical blob/file split
 *
 * The current model is 1:1 logical-file = physical-object: one row in
 * bunderstack_file_meta maps to exactly one object in storage. A future
 * blob/file split would introduce:
 *
 *   bunderstackBlob { key, bucket, size, contentType, refcount, createdAt }
 *   bunderstackFile { id, blobKey, ownerId, scopeJson, status, filename,
 *                     createdAt, confirmedAt, deletedAt }
 *
 * This would enable:
 *   - Soft/shadow delete (file.deletedAt + per-bucket retention policy)
 *   - Transfer ownership/scope (mutate file.ownerId / scopeJson, no byte movement)
 *   - Duplicate/share to many users or orgs by reference (refcount++) so sharing
 *     to N users stores bytes once; or by-copy via S3 CopyObject.
 *
 * Deletion would decrement refcount; bytes removed only at 0; orphan sweep also
 * reaps refcount=0 blobs (self-heals crash mid-decrement).
 *
 * Deferred because refcount correctness is a real cost vs. current need.
 *
 * Two forward-compat invariants keep this addable without breaking the public API:
 *   1. fileId is opaque — clients never parse it.
 *   2. All deletion goes through the storage delete helper, never inline.
 *
 * See docs/plans/2026-06-28-multi-bucket-storage-design.md §6 for full rationale.
 */

import { eq, and, lt, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { bunderstackFiles } from '../internal-tables.ts'
import type { ScopeMap } from '../access.ts'
import { rowMatchesScope } from '../access.ts'

export type FileMetaRow = typeof bunderstackFiles.$inferSelect

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function insertPendingFile(
  db: LibSQLDatabase<Record<string, unknown>>,
  input: {
    fileId: string
    bucket: string
    ownerId: string | null
    scopeJson: string | null
    filename: string | null
    contentType: string | null
  },
): Promise<void> {
  await db.insert(bunderstackFiles).values({
    fileId: input.fileId,
    bucket: input.bucket,
    ownerId: input.ownerId,
    scopeJson: input.scopeJson,
    filename: input.filename,
    contentType: input.contentType,
    status: 'pending',
    createdAt: Date.now(),
    confirmedAt: null,
    size: null,
  })
}

export async function insertReadyFile(
  db: LibSQLDatabase<Record<string, unknown>>,
  input: {
    fileId: string
    bucket: string
    ownerId: string | null
    scopeJson: string | null
    filename: string | null
    contentType: string | null
    size: number | null
  },
): Promise<void> {
  const now = Date.now()
  await db.insert(bunderstackFiles).values({
    fileId: input.fileId,
    bucket: input.bucket,
    ownerId: input.ownerId,
    scopeJson: input.scopeJson,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    status: 'ready',
    createdAt: now,
    confirmedAt: now,
  })
}

export async function markFileReady(
  db: LibSQLDatabase<Record<string, unknown>>,
  fileId: string,
  patch: { size: number | null; contentType: string | null },
): Promise<void> {
  await db
    .update(bunderstackFiles)
    .set({
      status: 'ready',
      confirmedAt: Date.now(),
      size: patch.size,
      contentType: patch.contentType,
    })
    .where(eq(bunderstackFiles.fileId, fileId))
}

export async function getFileMeta(
  db: LibSQLDatabase<Record<string, unknown>>,
  fileId: string,
): Promise<FileMetaRow | null> {
  const rows = await db
    .select()
    .from(bunderstackFiles)
    .where(eq(bunderstackFiles.fileId, fileId))
    .limit(1)
  return rows[0] ?? null
}

export async function deleteFileMetaRow(
  db: LibSQLDatabase<Record<string, unknown>>,
  fileId: string,
): Promise<void> {
  await db
    .delete(bunderstackFiles)
    .where(eq(bunderstackFiles.fileId, fileId))
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

export async function listStalePendingFiles(
  db: LibSQLDatabase<Record<string, unknown>>,
  olderThanMs: number,
): Promise<FileMetaRow[]> {
  return db
    .select()
    .from(bunderstackFiles)
    .where(
      and(
        eq(bunderstackFiles.status, 'pending'),
        lt(bunderstackFiles.createdAt, olderThanMs),
      ),
    )
}

// ─── Quota ────────────────────────────────────────────────────────────────────

export async function sumReadySize(
  db: LibSQLDatabase<Record<string, unknown>>,
  q: { bucket: string; ownerId?: string; scopeJson?: string },
): Promise<number> {
  const conditions = [
    eq(bunderstackFiles.status, 'ready'),
    eq(bunderstackFiles.bucket, q.bucket),
  ]
  if (q.ownerId !== undefined) {
    conditions.push(eq(bunderstackFiles.ownerId, q.ownerId))
  }
  if (q.scopeJson !== undefined) {
    conditions.push(eq(bunderstackFiles.scopeJson, q.scopeJson))
  }

  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(${bunderstackFiles.size}), 0)`,
    })
    .from(bunderstackFiles)
    .where(and(...conditions))

  const raw = rows[0]?.total ?? 0
  return Number(raw)
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

export function scopeToJson(scope: ScopeMap | undefined | null): string | null {
  if (scope == null) return null
  const keys = Object.keys(scope)
  if (keys.length === 0) return null
  const sorted = keys.sort()
  const ordered: Record<string, string | string[]> = {}
  for (const k of sorted) {
    ordered[k] = scope[k]
  }
  return JSON.stringify(ordered)
}

export function parseScopeJson(json: string | null): ScopeMap | null {
  if (json == null) return null
  return JSON.parse(json) as ScopeMap
}

export function fileMatchesScope(
  row: FileMetaRow,
  requesterScope: ScopeMap | undefined,
): boolean {
  if (requesterScope == null || Object.keys(requesterScope).length === 0) {
    return true
  }
  if (row.scopeJson == null) return false
  const parsed = parseScopeJson(row.scopeJson) ?? {}
  return rowMatchesScope(parsed, requesterScope)
}
