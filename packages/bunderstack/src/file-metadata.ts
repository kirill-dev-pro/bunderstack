import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { OperationRule } from './access.ts'

const META_TABLE = 'bunderstack_file_meta'

export type StorageAccessConfig = {
  create?: OperationRule
  get?: OperationRule
  delete?: OperationRule
}

export const DEFAULT_STORAGE_ACCESS: Required<StorageAccessConfig> = {
  create: 'authenticated',
  get: 'public',
  delete: 'owner',
}

export async function ensureFileMetaTable(db: LibSQLDatabase<Record<string, unknown>>): Promise<void> {
  await db.$client.execute(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      file_id TEXT PRIMARY KEY,
      owner_id TEXT
    )`,
  )
}

export async function setFileOwner(
  db: LibSQLDatabase<Record<string, unknown>>,
  fileId: string,
  ownerId: string | null,
): Promise<void> {
  await ensureFileMetaTable(db)
  await db.$client.execute({
    sql: `INSERT INTO ${META_TABLE} (file_id, owner_id) VALUES (?, ?)`,
    args: [fileId, ownerId],
  })
}

export async function getFileOwner(
  db: LibSQLDatabase<Record<string, unknown>>,
  fileId: string,
): Promise<string | null> {
  await ensureFileMetaTable(db)
  const result = await db.$client.execute({
    sql: `SELECT owner_id FROM ${META_TABLE} WHERE file_id = ?`,
    args: [fileId],
  })
  const row = result.rows[0] as { owner_id: string | null } | undefined
  return row?.owner_id ?? null
}

export async function deleteFileMeta(
  db: LibSQLDatabase<Record<string, unknown>>,
  fileId: string,
): Promise<void> {
  await db.$client.execute({
    sql: `DELETE FROM ${META_TABLE} WHERE file_id = ?`,
    args: [fileId],
  })
}

export async function checkFileAccess(
  rule: OperationRule,
  ownerId: string | null,
  userId: string | null,
): Promise<{ allowed: boolean; status: 401 | 403 }> {
  if (rule === 'deny') return { allowed: false, status: 403 }
  if (rule === 'public') return { allowed: true, status: 403 }
  if (!userId) return { allowed: false, status: 401 }
  if (rule === 'authenticated') return { allowed: true, status: 403 }
  if (rule === 'owner') {
    if (!ownerId || ownerId !== userId) return { allowed: false, status: 403 }
    return { allowed: true, status: 403 }
  }
  return { allowed: false, status: 403 }
}
