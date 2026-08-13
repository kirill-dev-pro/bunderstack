import { describe, expect, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createRealtimeFacade } from './facade'
import { createMemoryRealtimePublisher } from './publisher'

const boards = sqliteTable('workspace_boards', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const auditLogs = pgTable('audit_log', {
  id: pgText('id').primaryKey(),
  message: pgText('message').notNull(),
})

describe('RealtimeFacade', () => {
  test('derives SQLite and Postgres physical table names and delegates rows', async () => {
    const publisher = createMemoryRealtimePublisher()
    const events = publisher.subscribe('change')
    const realtime = createRealtimeFacade<{
      boards: typeof boards
      auditLogs: typeof auditLogs
    }>(publisher)

    expect(realtime.enabled).toBe(true)
    await realtime.publish(boards, 'create', { id: 'b1', title: 'Board' })
    await realtime.publish(auditLogs, 'delete', {
      id: 'a1',
      message: 'removed',
    })

    expect([(await events.next()).value, (await events.next()).value]).toEqual([
      {
        table: 'workspace_boards',
        action: 'create',
        record: { id: 'b1', title: 'Board' },
      },
      {
        table: 'audit_log',
        action: 'delete',
        record: { id: 'a1', message: 'removed' },
      },
    ])
  })

  test('is an enabled=false no-op without a publisher', async () => {
    const realtime = createRealtimeFacade<{ boards: typeof boards }>()

    expect(realtime.enabled).toBe(false)
    await expect(
      realtime.publish(boards, 'update', { id: 'b1', title: 'Updated' }),
    ).resolves.toBeUndefined()
  })

  test('constrains tables and records to the application schema', () => {
    const realtime = createRealtimeFacade<{ boards: typeof boards }>()

    if (false) {
      // @ts-expect-error users is not part of this application schema
      void realtime.publish(users, 'create', {
        id: 'u1',
        email: 'u@example.com',
      })
      // @ts-expect-error — title is required for a board create payload
      void realtime.publish(boards, 'create', { id: 'b1' })

      void realtime.publish(boards, 'create', {
        id: 'b1',
        title: 'Board',
        // @ts-expect-error — email is not a column in the boards table
        email: 'owner@example.com',
      })
      // @ts-expect-error action is restricted to create, update, or delete
      void realtime.publish(boards, 'replace', { id: 'b1', title: 'Board' })
    }

    expect(realtime.enabled).toBe(false)
  })

  test('reports disabled without a publisher', () => {
    const realtime = createRealtimeFacade()
    expect(realtime.enabled).toBe(false)
    expect(realtime.transport).toBe('disabled')
  })

  test.each([
    ['memory', 'memory'],
    ['redis', 'redis'],
  ] satisfies [
    import('./facade').RealtimeTransport,
    import('./facade').RealtimeTransport,
  ][])('reports %s transport', (transport, expected) => {
    const realtime = createRealtimeFacade(
      createMemoryRealtimePublisher(),
      transport,
    )
    expect(realtime.enabled).toBe(true)
    expect(realtime.transport).toBe(expected)
  })
})
