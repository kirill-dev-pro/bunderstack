import { and, eq, lt } from 'drizzle-orm'
import { createHash } from 'node:crypto'

import type { AnyDb } from './dialect'

import { idempotencyTableFor } from './internal-tables'

export type IdempotencyConfig = {
  ttlMs?: number
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export type IdempotencyLookup =
  | { type: 'replay'; status: number; response: string }
  | { type: 'conflict' }
  | { type: 'proceed' }

export async function lookupIdempotency(
  db: AnyDb,
  tableName: string,
  key: string,
  body: string,
  config: IdempotencyConfig,
): Promise<IdempotencyLookup> {
  const t = idempotencyTableFor(db)
  const now = Date.now()

  // TTL sweep: drop expired rows before reading.
  await db.delete(t).where(lt(t.expiresAt, now))

  const bodyHash = hashBody(body)
  const rows = await db
    .select({
      bodyHash: t.bodyHash,
      status: t.status,
      response: t.response,
      expiresAt: t.expiresAt,
    })
    .from(t)
    .where(and(eq(t.key, key), eq(t.tableName, tableName)))
    .limit(1)

  const row = rows[0]

  if (!row) return { type: 'proceed' }
  if (Number(row.expiresAt) < now) return { type: 'proceed' }
  if (row.bodyHash !== bodyHash) return { type: 'conflict' }
  return {
    type: 'replay',
    status: Number(row.status),
    response: String(row.response),
  }
}

export async function storeIdempotency(
  db: AnyDb,
  tableName: string,
  key: string,
  body: string,
  status: number,
  response: unknown,
  config: IdempotencyConfig,
): Promise<void> {
  const t = idempotencyTableFor(db)
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
  const expiresAt = Date.now() + ttlMs
  const bodyHash = hashBody(body)
  const responseText = JSON.stringify(response)

  await db
    .insert(t)
    .values({
      key,
      tableName,
      bodyHash,
      status,
      response: responseText,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [t.key, t.tableName],
      set: { bodyHash, status, response: responseText, expiresAt },
    })
}

export function resolveIdempotencyConfig(
  config: boolean | IdempotencyConfig | undefined,
): IdempotencyConfig | null {
  if (!config) return null
  if (config === true) return {}
  return config
}
