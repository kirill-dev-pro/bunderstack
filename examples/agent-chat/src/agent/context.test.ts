import { afterEach, describe, expect, test } from 'bun:test'

import { agentInbox, agentMemory, agentMessages, tasks } from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { agentDefinition } from './definition'
import { assembleAgentContext } from './context'
import { getOrCreateThread } from './runtime'

describe('turn context assembly', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  test('applies declaration limits to conversation, inbox, and memory', async () => {
    const app = await createTestApp()
    apps.push(app)
    const userId = await app.seedUser('Anonymous Owl')
    const thread = await getOrCreateThread(app.ctx.db, userId)
    const base = new Date('2026-08-26T10:00:00.000Z').getTime()

    await app.ctx.db.insert(agentMessages).values(
      Array.from({ length: 25 }, (_, index) => ({
        threadId: thread.id,
        userId,
        role: 'user' as const,
        content: `message-${index}`,
        createdAt: new Date(base + index),
      })),
    )
    await app.ctx.db.insert(agentMemory).values(
      Array.from({ length: 12 }, (_, index) => ({
        userId,
        kind: 'fact' as const,
        key: `memory-${index}`,
        value: `value-${index}`,
        sourceType: 'user' as const,
        createdAt: new Date(base + index),
        updatedAt: new Date(base + index),
      })),
    )
    await app.ctx.db.insert(agentInbox).values(
      Array.from({ length: 12 }, (_, index) => ({
        threadId: thread.id,
        userId,
        type: `event-${index}`,
        payload: { index },
        delivery: 'next_turn' as const,
        aggregate: 'latest' as const,
        createdAt: new Date(base + index),
      })),
    )
    await app.ctx.db.insert(tasks).values({ userId, title: 'Current task' })

    const context = await assembleAgentContext(app.ctx, {
      thread,
      reason: 'message.created',
      now: new Date(base + 100),
    })

    expect(context.messages).toHaveLength(20)
    expect(context.messages[0]?.content).toBe('message-5')
    expect(context.messages.at(-1)?.content).toBe('message-24')
    expect(context.memory).toHaveLength(8)
    expect(context.inbox).toHaveLength(10)
    expect(context.tasks).toMatchObject([{ title: 'Current task' }])
    expect(context.trigger).toEqual({
      type: 'user',
      trusted: true,
      reason: 'message.created',
    })
    expect(context.instructions).toBe(
      agentDefinition.instructions({ now: new Date(base + 100) }),
    )
    expect(context.selectedInboxIds).toHaveLength(10)
  })
})
