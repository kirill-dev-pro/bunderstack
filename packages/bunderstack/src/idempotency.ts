import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { and, eq, lt } from 'drizzle-orm'
import { createHash } from 'node:crypto'

import { bunderstackIdempotency } from './internal-tables.ts'

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
  db: LibSQLDatabase<Record<string, unknown>>,
  tableName: string,
  key: string,
  body: string,
  config: IdempotencyConfig,
): Promise<IdempotencyLookup> {
  const now = Date.now()

  // TTL sweep: drop expired rows before reading.
  await db
    .delete(bunderstackIdempotency)
    .where(lt(bunderstackIdempotency.expiresAt, now))

  const bodyHash = hashBody(body)
  const rows = await db
    .select({
      bodyHash: bunderstackIdempotency.bodyHash,
      status: bunderstackIdempotency.status,
      response: bunderstackIdempotency.response,
      expiresAt: bunderstackIdempotency.expiresAt,
    })
    .from(bunderstackIdempotency)
    .where(
      and(
        eq(bunderstackIdempotency.key, key),
        eq(bunderstackIdempotency.tableName, tableName),
      ),
    )
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
  db: LibSQLDatabase<Record<string, unknown>>,
  tableName: string,
  key: string,
  body: string,
  status: number,
  response: unknown,
  config: IdempotencyConfig,
): Promise<void> {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
  const expiresAt = Date.now() + ttlMs
  const bodyHash = hashBody(body)
  const responseText = JSON.stringify(response)

  await db
    .insert(bunderstackIdempotency)
    .values({
      key,
      tableName,
      bodyHash,
      status,
      response: responseText,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [bunderstackIdempotency.key, bunderstackIdempotency.tableName],
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
