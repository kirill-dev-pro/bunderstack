import { and, eq } from 'drizzle-orm'

import type { AnyDb } from '../dialect'

import { messagesTableFor } from '../internal-tables'

export async function insertMessage(
  db: AnyDb | undefined,
  value: Record<string, unknown>,
) {
  if (!db) return
  await db.insert(messagesTableFor(db)).values(value)
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
