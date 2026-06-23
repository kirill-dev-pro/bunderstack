import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { createHash } from 'node:crypto'

export type IdempotencyConfig = {
  ttlMs?: number
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

let tableReady = false

async function ensureTable(db: LibSQLDatabase<Record<string, unknown>>) {
  if (tableReady) return
  await db.$client.execute(`
    CREATE TABLE IF NOT EXISTS _bunderstack_idempotency (
      key TEXT NOT NULL,
      table_name TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (key, table_name)
    )
  `)
  tableReady = true
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export type IdempotencyLookup =
  | { type: 'replay'; status: number; response: string }
  | { type: 'conflict' }
  | { type: 'proceed' }

export async function lookupIdempotency(
  db: LibSQLDatabase<Record<string, unknown>>,
  tableName: string,
  key: string,
  body: string,
  config: IdempotencyConfig,
): Promise<IdempotencyLookup> {
  await ensureTable(db)
  const now = Date.now()

  await db.$client.execute({
    sql: `DELETE FROM _bunderstack_idempotency WHERE expires_at < ?`,
    args: [now],
  })

  const bodyHash = hashBody(body)
  const rows = await db.$client.execute({
    sql: `SELECT body_hash, status, response, expires_at FROM _bunderstack_idempotency WHERE key = ? AND table_name = ?`,
    args: [key, tableName],
  })

  const row = rows.rows[0] as
    | { body_hash: string; status: number; response: string; expires_at: number }
    | undefined

  if (!row) return { type: 'proceed' }
  if (Number(row.expires_at) < now) return { type: 'proceed' }
  if (row.body_hash !== bodyHash) return { type: 'conflict' }
  return {
    type: 'replay',
    status: Number(row.status),
    response: String(row.response),
  }
}

export async function storeIdempotency(
  db: LibSQLDatabase<Record<string, unknown>>,
  tableName: string,
  key: string,
  body: string,
  status: number,
  response: unknown,
  config: IdempotencyConfig,
): Promise<void> {
  await ensureTable(db)
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
  const expiresAt = Date.now() + ttlMs
  const bodyHash = hashBody(body)
  const responseText = JSON.stringify(response)

  await db.$client.execute({
    sql: `INSERT OR REPLACE INTO _bunderstack_idempotency (key, table_name, body_hash, status, response, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [key, tableName, bodyHash, status, responseText, expiresAt],
  })
}

export function resolveIdempotencyConfig(
  config: boolean | IdempotencyConfig | undefined,
): IdempotencyConfig | null {
  if (!config) return null
  if (config === true) return {}
  return config
}
