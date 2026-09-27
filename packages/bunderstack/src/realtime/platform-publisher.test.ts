import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { createMemoryRealtimePublisher, type RealtimeChange } from './publisher'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

test('the runtime publishes through the platform publisher', async () => {
  const publisher = createMemoryRealtimePublisher()
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    realtime: true,
  }).start({
    env: { DATABASE_URL: ':memory:', REDIS_URL: 'redis://ignored.invalid' },
    platform: { realtime: publisher },
  })
  try {
    expect(app.realtime.transport).toBe('platform')
    const events: RealtimeChange[] = []
    const unsubscribe = await publisher.subscribe('change', (event) => {
      events.push(event)
    })
    await app.realtime.publish(notes, 'create', { id: 'n1' })
    await unsubscribe()
    expect(events).toEqual([
      expect.objectContaining({ table: 'notes', action: 'create' }),
    ])
  } finally {
    await app.close()
  }
})

test('without a platform publisher the runtime uses memory', async () => {
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    realtime: true,
  }).start({ env: { DATABASE_URL: ':memory:' } })
  try {
    expect(app.realtime.transport).toBe('memory')
  } finally {
    await app.close()
  }
})
