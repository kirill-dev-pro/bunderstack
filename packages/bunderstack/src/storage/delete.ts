// src/storage/delete.ts
import type { AnyDb } from '../dialect'
import type { StorageAdapter } from './index'

import { deleteFileMetaRow } from './file-meta'

/**
 * Delete a logical file: its transform-cache derivatives (under
 * `${fileId}__transforms/`), the original object, and the file-meta row.
 *
 * All deletion goes through this helper so the model stays addable to a future
 * blob/file split (see file-meta.ts header) — never inline `adapter.delete`.
 */
export async function deleteFileWithDerivatives(
  adapter: StorageAdapter,
  db: AnyDb,
  fileId: string,
): Promise<void> {
  if (adapter.list) {
    const derivs = await adapter.list(`${fileId}__transforms/`)
    // Ignore individual derivative-delete errors — orphan sweep is the backstop.
    await Promise.all(derivs.map((k) => adapter.delete(k).catch(() => {})))
  }
  await adapter.delete(fileId)
  await deleteFileMetaRow(db, fileId)
}
