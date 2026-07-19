import { describe, expect, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { RealtimeBroker } from './index'
import { createRealtimeFacade } from './facade'

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

function recordingBroker(
  events: Array<Record<string, unknown>>,
): RealtimeBroker {
  return {
    async start() {},
    async close() {},
    register: () => ({ id: 'subscriber' }),
    setContext: () => ({ gap: false }),
    unregister() {},
    async publish(table, action, record) {
      events.push({ table, action, record })
    },
  }
}

describe('RealtimeFacade', () => {
  test('derives SQLite and Postgres physical table names and delegates rows', async () => {
    const events: Array<Record<string, unknown>> = []
    const realtime = createRealtimeFacade<{
      boards: typeof boards
      auditLogs: typeof auditLogs
    }>(recordingBroker(events))

    expect(realtime.enabled).toBe(true)
    await realtime.publish(boards, 'create', { id: 'b1', title: 'Board' })
    await realtime.publish(auditLogs, 'delete', {
      id: 'a1',
      message: 'removed',
    })

    expect(events).toEqual([
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

  test('is an enabled=false no-op without a broker', async () => {
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
      void realtime.publish(users, 'create', { id: 'u1', email: 'u@example.com' })
      // @ts-expect-error a board record requires title and does not accept email
      void realtime.publish(boards, 'create', { id: 'b1', email: 'u@example.com' })
      // @ts-expect-error action is restricted to create, update, or delete
      void realtime.publish(boards, 'replace', { id: 'b1', title: 'Board' })
    }

    expect(realtime.enabled).toBe(false)
  })
})
