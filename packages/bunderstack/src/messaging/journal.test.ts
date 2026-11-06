import { test, expect, beforeEach } from 'bun:test'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import {
  bunderstackMessageEvents,
  bunderstackMessages,
  INTERNAL_TABLES,
} from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import {
  insertMessage,
  MESSAGE_RETENTION_MS,
  reapMessageJournal,
} from './journal'

let db: Awaited<ReturnType<typeof createDb<typeof INTERNAL_TABLES>>>['db']

beforeEach(async () => {
  ;({ db } = await createDb(INTERNAL_TABLES, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  }))
  await provisionSchema(db, INTERNAL_TABLES, { force: true })
})

function message(id: string, createdAt: number) {
  return {
    id,
    channel: 'email',
    kind: 'email',
    provider: 'resend',
    credentialSource: 'managed',
    status: 'sent',
    recipientsJson: '[]',
    contentJson: '{}',
    createdAt,
    updatedAt: createdAt,
  }
}

async function addEvent(messageId: string, at: number) {
  await db.insert(bunderstackMessageEvents).values({
    id: `event_${messageId}`,
    messageId,
    externalId: `external_${messageId}`,
    type: 'delivered',
    occurredAt: at,
    createdAt: at,
  })
}

test('messages and their events past the retention window are deleted', async () => {
  const now = Date.parse('2026-11-06T10:00:00Z')
  const old = now - MESSAGE_RETENTION_MS - 1
  const recent = now - MESSAGE_RETENTION_MS + 60_000
  await db
    .insert(bunderstackMessages)
    .values([message('message_old', old), message('message_recent', recent)])
  await addEvent('message_old', old)
  await addEvent('message_recent', recent)

  await reapMessageJournal(db, now)

  const messages = await db.select().from(bunderstackMessages)
  const events = await db.select().from(bunderstackMessageEvents)
  expect(messages.map((row) => row.id)).toEqual(['message_recent'])
  expect(events.map((row) => row.messageId)).toEqual(['message_recent'])
})

test('a backlog larger than one batch is deleted in one sweep', async () => {
  const now = Date.parse('2026-11-06T10:00:00Z')
  const old = now - MESSAGE_RETENTION_MS - 1
  const rows = Array.from({ length: 1_200 }, (_, i) =>
    message(`message_${i}`, old),
  )
  for (let i = 0; i < rows.length; i += 300) {
    await db.insert(bunderstackMessages).values(rows.slice(i, i + 300))
  }

  await reapMessageJournal(db, now)

  expect(await db.select().from(bunderstackMessages)).toHaveLength(0)
})

test('the sweep runs at most hourly per database', async () => {
  const now = Date.parse('2026-11-06T10:00:00Z')
  await reapMessageJournal(db, now)
  await db
    .insert(bunderstackMessages)
    .values(message('message_old', now - MESSAGE_RETENTION_MS - 1))

  await reapMessageJournal(db, now + 60_000)
  expect(await db.select().from(bunderstackMessages)).toHaveLength(1)

  await reapMessageJournal(db, now + 3_600_001)
  expect(await db.select().from(bunderstackMessages)).toHaveLength(0)
})

test('inserting a message sweeps the journal', async () => {
  const old = Date.now() - MESSAGE_RETENTION_MS - 60_000
  await db.insert(bunderstackMessages).values(message('message_old', old))

  await insertMessage(db, message('message_new', Date.now()))

  const messages = await db.select().from(bunderstackMessages)
  expect(messages.map((row) => row.id)).toEqual(['message_new'])
})
