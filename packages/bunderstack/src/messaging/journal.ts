import { and, eq, inArray, lt } from 'drizzle-orm'

import type { AnyDb } from '../dialect'

import { messageEventsTableFor, messagesTableFor } from '../internal-tables'

/** The journal backs the dashboard's message history and delivery tracking.
 *  Each row keeps recipients and full content, so it is not kept forever. */
export const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const REAP_INTERVAL_MS = 60 * 60_000
const REAP_BATCH = 500

const lastReapAt = new WeakMap<object, number>()

export async function insertMessage(
  db: AnyDb | undefined,
  value: Record<string, unknown>,
) {
  if (!db) return
  await db.insert(messagesTableFor(db)).values(value)
  await reapMessageJournal(db)
}

/**
 * Deletes journal rows older than {@link MESSAGE_RETENTION_MS}, at most once
 * an hour per database handle. Writers call it after inserting, so the
 * journal is bounded without a scheduler of its own. Events go first and
 * explicitly: SQLite enforces `ON DELETE CASCADE` only with foreign keys on.
 * A failure is logged and never fails the write that triggered it.
 */
export async function reapMessageJournal(db: AnyDb, now = Date.now()) {
  if (now - (lastReapAt.get(db) ?? 0) < REAP_INTERVAL_MS) return
  lastReapAt.set(db, now)
  const messages = messagesTableFor(db)
  const events = messageEventsTableFor(db)
  const cutoff = now - MESSAGE_RETENTION_MS
  try {
    for (;;) {
      const expired = await db
        .select({ id: messages.id })
        .from(messages)
        .where(lt(messages.createdAt, cutoff))
        .limit(REAP_BATCH)
      if (expired.length === 0) break
      const ids = expired.map((row: { id: unknown }) => String(row.id))
      await db.delete(events).where(inArray(events.messageId, ids))
      await db.delete(messages).where(inArray(messages.id, ids))
      if (expired.length < REAP_BATCH) break
    }
  } catch (error) {
    console.warn('[bunderstack] message journal cleanup failed:', error)
  }
}

export async function updateMessage(
  db: AnyDb | undefined,
  id: string,
  value: Record<string, unknown>,
  expectedStatus?: string,
) {
  if (!db) return
  const table = messagesTableFor(db)
  await db
    .update(table)
    .set(value)
    .where(
      expectedStatus
        ? and(eq(table.id, id), eq(table.status, expectedStatus))
        : eq(table.id, id),
    )
}
