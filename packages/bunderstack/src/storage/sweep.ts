// src/storage/sweep.ts
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import type { BucketStorageRegistry } from './registry.ts'

import { deleteFileMetaRow, listStalePendingFiles } from './file-meta.ts'

/**
 * Reap stale `pending` file-meta rows (two-phase uploads that never confirmed)
 * older than `olderThanMs`. For each, best-effort delete the object (it may
 * never have landed) then remove the meta row. Returns the number reaped.
 */
export async function sweepOrphans(
  registry: BucketStorageRegistry,
  db: LibSQLDatabase<Record<string, unknown>>,
  olderThanMs: number,
): Promise<number> {
  const cutoff = Date.now() - olderThanMs
  const rows = await listStalePendingFiles(db, cutoff)
  for (const row of rows) {
    const adapter = registry.get(row.bucket)?.adapter
    await adapter?.delete(row.fileId).catch(() => {})
    await deleteFileMetaRow(db, row.fileId)
  }
  return rows.length
}
