import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { generateTypeId, mockAuthSession } from 'bunderstack'

import {
  agentInbox,
  agentMemory,
  agentRequests,
  agentRuns,
  agentThreads,
  agentToolGrants,
} from '../schema'
import { createTestApp, type TestApp } from '../test-app'

describe('durable agent state schema', () => {
  let testApp: TestApp | undefined

  afterEach(async () => {
    await testApp?.close()
    testApp = undefined
  })

  test('stores owned memory, inbox, requests, and grants with JSON and status defaults', async () => {
    testApp = await createTestApp()
    const userId = await testApp.seedUser('Anonymous Owl')
    const threadId = generateTypeId('athread')
    const runId = generateTypeId('arun')
    await testApp.ctx.db.insert(agentThreads).values({ id: threadId, userId })
    await testApp.ctx.db.insert(agentRuns).values({
      id: runId,
      threadId,
      userId,
      reason: 'message.created',
      status: 'running',
    })

    await testApp.ctx.db.insert(agentMemory).values({
      id: generateTypeId('amem'),
      userId,
      kind: 'preference',
      key: 'address_style',
      value: { form: 'formal' },
      sourceType: 'user',
    })
    await testApp.ctx.db.insert(agentInbox).values({
      id: generateTypeId('ainbox'),
      threadId,
      userId,
      type: 'subscription.limit_near',
      payload: { remaining: 2 },
      delivery: 'next_turn',
      aggregate: 'latest',
    })
    await testApp.ctx.db.insert(agentRequests).values({
      id: generateTypeId('arequest'),
      threadId,
      userId,
      runId,
      kind: 'approval',
      prompt: 'Delete the task?',
      tool: 'deleteTask',
      toolVersion: 1,
      args: { taskId: 'task_example' },
    })
    await testApp.ctx.db.insert(agentToolGrants).values({
      id: generateTypeId('agrant'),
      threadId,
      userId,
      tool: 'deleteTask',
      toolVersion: 1,
      scope: {},
    })

    expect(
      await testApp.ctx.db.select().from(agentMemory).where(eq(agentMemory.userId, userId)),
    ).toMatchObject([
      { key: 'address_style', value: { form: 'formal' } },
    ])
    expect(
      await testApp.ctx.db.select().from(agentInbox).where(eq(agentInbox.userId, userId)),
    ).toMatchObject([
      { payload: { remaining: 2 }, status: 'pending' },
    ])
    expect(
      await testApp.ctx.db.select().from(agentRequests).where(eq(agentRequests.userId, userId)),
    ).toMatchObject([
      { args: { taskId: 'task_example' }, status: 'pending' },
    ])
    expect(
      await testApp.ctx.db
        .select()
        .from(agentToolGrants)
        .where(eq(agentToolGrants.userId, userId)),
    ).toMatchObject([{ scope: {}, status: 'active' }])
  })

  test('generated read APIs scope memory and grants to the authenticated user', async () => {
    testApp = await createTestApp()
    const aliceId = await testApp.seedUser('Anonymous Fox')
    const bobId = await testApp.seedUser('Anonymous Bear')
    const aliceThreadId = generateTypeId('athread')
    const bobThreadId = generateTypeId('athread')
    await testApp.ctx.db.insert(agentThreads).values([
      { id: aliceThreadId, userId: aliceId },
      { id: bobThreadId, userId: bobId },
    ])
    await testApp.ctx.db.insert(agentMemory).values([
      {
        id: generateTypeId('amem'),
        userId: aliceId,
        kind: 'fact',
        key: 'owner',
        value: 'alice',
        sourceType: 'user',
      },
      {
        id: generateTypeId('amem'),
        userId: bobId,
        kind: 'fact',
        key: 'owner',
        value: 'bob',
        sourceType: 'user',
      },
    ])
    await testApp.ctx.db.insert(agentToolGrants).values([
      {
        id: generateTypeId('agrant'),
        threadId: aliceThreadId,
        userId: aliceId,
        tool: 'deleteTask',
        toolVersion: 1,
        scope: {},
      },
      {
        id: generateTypeId('agrant'),
        threadId: bobThreadId,
        userId: bobId,
        tool: 'deleteTask',
        toolVersion: 1,
        scope: {},
      },
    ])

    mockAuthSession(testApp.app, async () => ({
      user: { id: aliceId, email: 'alice@example.test', name: 'Alice' },
    }))

    const memoryResponse = await testApp.app.handler(
      new Request('http://localhost/api/agent_memory'),
    )
    const grantsResponse = await testApp.app.handler(
      new Request('http://localhost/api/agent_tool_grants'),
    )
    expect(memoryResponse.status).toBe(200)
    expect(grantsResponse.status).toBe(200)
    expect(await memoryResponse.json()).toMatchObject({
      items: [{ userId: aliceId, value: 'alice' }],
    })
    expect(await grantsResponse.json()).toMatchObject({
      items: [{ userId: aliceId, threadId: aliceThreadId }],
    })
  })
})
