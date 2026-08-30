import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  agentCommitments,
  agentInbox,
  agentMemory,
  agentMessages,
  agentRequests,
  agentRunSteps,
  agentRuns,
  agentThreads,
  agentToolCalls,
  agentToolGrants,
  tasks,
  user,
} from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { transferAnonymousAgentData } from './auth-transfer'
import { getOrCreateThread } from './runtime'

describe('anonymous agent account transfer', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  test('moves the complete personal agent graph before the anonymous user is deleted', async () => {
    const app = await createTestApp()
    apps.push(app)
    const anonymousId = await app.seedUser('Gentle Otter')
    const permanentId = await app.seedUser('Alice')
    const thread = await getOrCreateThread(app.ctx.db, anonymousId)
    const [run] = await app.ctx.db
      .insert(agentRuns)
      .values({
        threadId: thread.id,
        userId: anonymousId,
        reason: 'message',
        status: 'complete',
      })
      .returning()
    await app.ctx.db.insert(agentMessages).values({
      threadId: thread.id,
      userId: anonymousId,
      role: 'user',
      content: 'Hello',
    })
    await app.ctx.db.insert(agentToolCalls).values({
      runId: run!.id,
      threadId: thread.id,
      userId: anonymousId,
      tool: 'listTasks',
      args: {},
      result: [],
      status: 'done',
    })
    await app.ctx.db.insert(agentRunSteps).values({
      runId: run!.id,
      threadId: thread.id,
      userId: anonymousId,
      sequence: 1,
      kind: 'tool_call',
      title: 'listTasks v1',
      status: 'complete',
      visibility: 'visible',
      input: {},
      output: [],
    })
    await app.ctx.db.insert(agentCommitments).values({
      threadId: thread.id,
      userId: anonymousId,
      kind: 'reminder',
      title: 'Check oven',
      dueAt: new Date('2026-08-27T10:00:00.000Z'),
    })
    await app.ctx.db.insert(tasks).values({
      userId: anonymousId,
      title: 'Book flights',
    })
    await app.ctx.db.insert(agentMemory).values({
      userId: anonymousId,
      kind: 'fact',
      key: 'tone',
      value: 'brief',
      sourceType: 'user',
    })
    await app.ctx.db.insert(agentInbox).values({
      threadId: thread.id,
      userId: anonymousId,
      type: 'subscription.limit_near',
      payload: { remaining: 2 },
      delivery: 'next_turn',
      aggregate: 'latest',
    })
    await app.ctx.db.insert(agentRequests).values({
      threadId: thread.id,
      userId: anonymousId,
      runId: run!.id,
      kind: 'approval',
      prompt: 'Approve?',
      tool: 'deleteTask',
      toolVersion: 1,
      args: { taskId: 'task_missing' },
    })
    await app.ctx.db.insert(agentToolGrants).values({
      threadId: thread.id,
      userId: anonymousId,
      tool: 'deleteTask',
      toolVersion: 1,
      scope: {},
    })

    await transferAnonymousAgentData(app.ctx.db, anonymousId, permanentId)

    const ownedTables = [
      agentThreads,
      agentMessages,
      agentRuns,
      agentRunSteps,
      agentToolCalls,
      agentCommitments,
      tasks,
      agentMemory,
      agentInbox,
      agentRequests,
      agentToolGrants,
    ] as const
    for (const table of ownedTables) {
      expect(
        await app.ctx.db
          .select()
          .from(table)
          .where(eq(table.userId, anonymousId))
          .all(),
      ).toHaveLength(0)
      expect(
        await app.ctx.db
          .select()
          .from(table)
          .where(eq(table.userId, permanentId))
          .all(),
      ).toHaveLength(1)
    }

    await app.ctx.db.delete(user).where(eq(user.id, anonymousId))
    expect(await app.ctx.db.select().from(agentThreads).all()).toHaveLength(1)
    expect(await app.ctx.db.select().from(agentMessages).all()).toHaveLength(1)
  })

  test('refuses to merge when the permanent account already has an agent', async () => {
    const app = await createTestApp()
    apps.push(app)
    const anonymousId = await app.seedUser('Gentle Otter')
    const permanentId = await app.seedUser('Alice')
    await getOrCreateThread(app.ctx.db, anonymousId)
    await getOrCreateThread(app.ctx.db, permanentId)

    await expect(
      transferAnonymousAgentData(app.ctx.db, anonymousId, permanentId),
    ).rejects.toThrow('already has an agent')
  })
})
