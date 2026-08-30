import { afterEach, describe, expect, test } from 'bun:test'
import { generateTypeId } from 'bunderstack'
import { mockAuthSession } from 'bunderstack/testing'
import { eq } from 'drizzle-orm'

import {
  agentCommitmentDependencies,
  agentCommitments,
  agentInbox,
  agentMemory,
  agentMessages,
  agentRequests,
  agentRunSteps,
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
      await testApp.ctx.db
        .select()
        .from(agentMemory)
        .where(eq(agentMemory.userId, userId)),
    ).toMatchObject([{ key: 'address_style', value: { form: 'formal' } }])
    expect(
      await testApp.ctx.db
        .select()
        .from(agentInbox)
        .where(eq(agentInbox.userId, userId)),
    ).toMatchObject([{ payload: { remaining: 2 }, status: 'pending' }])
    expect(
      await testApp.ctx.db
        .select()
        .from(agentRequests)
        .where(eq(agentRequests.userId, userId)),
    ).toMatchObject([{ args: { taskId: 'task_example' }, status: 'pending' }])
    expect(
      await testApp.ctx.db
        .select()
        .from(agentToolGrants)
        .where(eq(agentToolGrants.userId, userId)),
    ).toMatchObject([{ scope: {}, status: 'active' }])
  })

  test('stores a waiting run checkpoint and exact AI approval identifiers', async () => {
    testApp = await createTestApp()
    const userId = await testApp.seedUser('Patient Heron')
    const threadId = generateTypeId('athread')
    const runId = generateTypeId('arun')
    await testApp.ctx.db.insert(agentThreads).values({ id: threadId, userId })
    await testApp.ctx.db.insert(agentRuns).values({
      id: runId,
      threadId,
      userId,
      reason: 'message',
      status: 'waiting_for_approval',
      checkpoint: {
        messages: [
          { role: 'user', content: 'Delete book flights' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_delete_1',
                toolName: 'deleteTask',
                input: { taskId: 'task_book_flights' },
              },
            ],
          },
        ],
      },
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
      args: { taskId: 'task_book_flights' },
      approvalId: 'approval_delete_1',
      toolCallId: 'call_delete_1',
    })

    const storedRun = await testApp.ctx.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .get()
    expect(storedRun?.status).toBe('waiting_for_approval')
    expect(storedRun?.checkpoint).toEqual({
      messages: [
        { role: 'user', content: 'Delete book flights' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_delete_1',
              toolName: 'deleteTask',
              input: { taskId: 'task_book_flights' },
            },
          ],
        },
      ],
    })
    expect(
      await testApp.ctx.db
        .select()
        .from(agentRequests)
        .where(eq(agentRequests.runId, runId))
        .get(),
    ).toMatchObject({
      approvalId: 'approval_delete_1',
      toolCallId: 'call_delete_1',
    })
  })

  test('stores a revisioned assistant draft and visible run steps', async () => {
    testApp = await createTestApp()
    const userId = await testApp.seedUser('Streaming Lynx')
    const threadId = generateTypeId('athread')
    const inputMessageId = generateTypeId('amsg')
    const runId = generateTypeId('arun')
    const assistantMessageId = generateTypeId('amsg')

    await testApp.ctx.db.insert(agentThreads).values({ id: threadId, userId })
    await testApp.ctx.db.insert(agentMessages).values({
      id: inputMessageId,
      threadId,
      userId,
      role: 'user',
      content: 'List tasks',
      clientMessageId: 'browser-message-1',
    })
    await testApp.ctx.db.insert(agentRuns).values({
      id: runId,
      threadId,
      userId,
      inputMessageId,
      assistantMessageId,
      triggerType: 'user_message',
      reason: 'message',
      status: 'queued',
    })
    await testApp.ctx.db.insert(agentMessages).values({
      id: assistantMessageId,
      threadId,
      userId,
      runId,
      role: 'assistant',
      content: 'Three',
      status: 'streaming',
      revision: 2,
    })
    await testApp.ctx.db.insert(agentRunSteps).values({
      runId,
      threadId,
      userId,
      sequence: 1,
      kind: 'tool_call',
      title: 'listTasks v1',
      status: 'complete',
      visibility: 'visible',
      input: {},
      output: [{ id: 'task_1' }],
    })

    expect(await testApp.ctx.db.select().from(agentMessages).all()).toMatchObject([
      { id: inputMessageId, clientMessageId: 'browser-message-1' },
      {
        id: assistantMessageId,
        runId,
        status: 'streaming',
        revision: 2,
      },
    ])
    expect(await testApp.ctx.db.select().from(agentRunSteps).get()).toMatchObject({
      runId,
      sequence: 1,
      kind: 'tool_call',
      status: 'complete',
      input: {},
    })
  })

  test('allows only one active user-message run but independent commitment runs', async () => {
    testApp = await createTestApp()
    const userId = await testApp.seedUser('Concurrent Ibis')
    const threadId = generateTypeId('athread')
    await testApp.ctx.db.insert(agentThreads).values({ id: threadId, userId })

    await testApp.ctx.db.insert(agentRuns).values({
      threadId,
      userId,
      triggerType: 'user_message',
      reason: 'message',
      status: 'running',
    })
    await expect(
      testApp.ctx.db
        .insert(agentRuns)
        .values({
          threadId,
          userId,
          triggerType: 'user_message',
          reason: 'message',
          status: 'queued',
        })
        .run(),
    ).rejects.toThrow()

    await testApp.ctx.db.insert(agentRuns).values([
      {
        threadId,
        userId,
        triggerType: 'commitment',
        reason: 'commitment.one',
        status: 'waiting_for_approval',
      },
      {
        threadId,
        userId,
        triggerType: 'commitment',
        reason: 'commitment.two',
        status: 'waiting_for_approval',
      },
    ])
    expect(await testApp.ctx.db.select().from(agentRuns).all()).toHaveLength(3)
  })

  test('stores executable commitments, dependencies, and linked execution attempts', async () => {
    testApp = await createTestApp()
    const userId = await testApp.seedUser('Durable Raven')
    const threadId = generateTypeId('athread')
    const firstId = generateTypeId('acommit')
    const secondId = generateTypeId('acommit')
    const runId = generateTypeId('arun')
    const startedAt = new Date('2026-08-26T17:00:00.000Z')
    const completedAt = new Date('2026-08-26T17:00:02.000Z')
    await testApp.ctx.db.insert(agentThreads).values({ id: threadId, userId })
    await testApp.ctx.db.insert(agentCommitments).values([
      {
        id: firstId,
        threadId,
        userId,
        kind: 'notify',
        title: 'Tell me to stretch',
        executionSpec: { kind: 'notify', message: 'Time to stretch' },
        dueAt: new Date('2026-08-26T17:00:00.000Z'),
      },
      {
        id: secondId,
        threadId,
        userId,
        kind: 'tool_call',
        title: 'Create evening task',
        executionSpec: {
          kind: 'tool_call',
          tool: 'createTask',
          args: { title: 'Prepare dinner' },
        },
        dueAt: new Date('2026-08-26T17:05:00.000Z'),
        status: 'blocked',
      },
    ])
    await testApp.ctx.db.insert(agentCommitmentDependencies).values({
      commitmentId: secondId,
      dependsOnCommitmentId: firstId,
    })
    await testApp.ctx.db.insert(agentRuns).values({
      id: runId,
      threadId,
      userId,
      commitmentId: secondId,
      triggerType: 'commitment',
      reason: 'commitment.due',
      status: 'running',
      startedAt,
    })
    await testApp.ctx.db
      .update(agentCommitments)
      .set({
        status: 'completed',
        currentRunId: runId,
        result: { taskId: 'task_evening' },
        startedAt,
        completedAt,
      })
      .where(eq(agentCommitments.id, secondId))

    expect(
      await testApp.ctx.db
        .select()
        .from(agentCommitments)
        .where(eq(agentCommitments.id, secondId))
        .get(),
    ).toMatchObject({
      kind: 'tool_call',
      status: 'completed',
      currentRunId: runId,
      executionSpec: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Prepare dinner' },
      },
      result: { taskId: 'task_evening' },
      startedAt,
      completedAt,
    })
    expect(
      await testApp.ctx.db.select().from(agentCommitmentDependencies).all(),
    ).toEqual([{ commitmentId: secondId, dependsOnCommitmentId: firstId }])
    expect(
      await testApp.ctx.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .get(),
    ).toMatchObject({
      commitmentId: secondId,
      triggerType: 'commitment',
    })
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
