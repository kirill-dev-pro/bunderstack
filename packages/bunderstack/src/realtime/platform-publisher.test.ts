import { MemoryPublisher } from '@orpc/publisher/memory'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { provision } from '../provision-schema'
import {
  createMemoryRealtimePublisher,
  type RealtimeChange,
  type RealtimeEvents,
} from './publisher'

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

// A Worker cancels I/O that is still pending after the response; a
// fire-and-forget publish to the hub then never arrives.
test('a CRUD write finishes its realtime publish before it responds', async () => {
  class SlowPublisher extends MemoryPublisher<RealtimeEvents> {
    finished = 0
    override async publish<K extends keyof RealtimeEvents & string>(
      event: K,
      payload: RealtimeEvents[K],
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await super.publish(event, payload)
      this.finished++
    }
  }
  const publisher = new SlowPublisher()
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    access: { notes: { crud: true, create: 'public', list: 'public' } },
    realtime: true,
  } as never).start({
    env: { DATABASE_URL: ':memory:' },
    platform: { realtime: publisher },
  })
  try {
    await provision(app, { force: true })
    const res = await app.handler(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'n1' }),
      }),
    )
    expect(res.status).toBe(201)
    expect(publisher.finished).toBe(1)
  } finally {
    await app.close()
  }
})

test('a failing realtime publish does not fail the write', async () => {
  const failing = createMemoryRealtimePublisher()
  failing.publish = async () => {
    throw new Error('hub is down')
  }
  const app = await bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    access: { notes: { crud: true, create: 'public' } },
    realtime: true,
  } as never).start({
    env: { DATABASE_URL: ':memory:' },
    platform: { realtime: failing },
  })
  try {
    await provision(app, { force: true })
    const res = await app.handler(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'n2' }),
      }),
    )
    expect(res.status).toBe(201)
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
