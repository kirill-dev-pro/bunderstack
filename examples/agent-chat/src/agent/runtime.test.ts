import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  agentCommitments,
  agentInbox,
  agentMessages,
  agentRequests,
  agentRunSteps,
  agentRuns,
  agentThreads,
  agentToolCalls,
  tasks,
} from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { resolveApproval } from './approvals'
import { requestRunCancellation } from './cancellation'
import { acceptUserMessage } from './messages'
import {
  fireCommitment,
  getOrCreateThread,
  runAgentTurn,
  wakeAgent,
} from './runtime'

describe('agent runtime', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((testApp) => testApp.close()))
  })

  async function setup() {
    const testApp = await createTestApp()
    apps.push(testApp)
    const userId = await testApp.seedUser('Alice')
    const thread = await getOrCreateThread(testApp.ctx.db, userId)
    return { ...testApp, userId, thread }
  }

  const completed = (text: string) => ({
    status: 'completed' as const,
    text,
    checkpoint: { messages: [] },
  })

  const waiting = (taskId: string, sequence = 1) => ({
    status: 'waiting_for_approval' as const,
    request: {
      approvalId: `approval_delete_${sequence}`,
      toolCallId: `call_delete_${sequence}`,
      tool: 'deleteTask',
      args: { taskId },
    },
    checkpoint: {
      messages: [
        { role: 'user' as const, content: 'Delete the task' },
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: `call_delete_${sequence}`,
              toolName: 'deleteTask',
              input: { taskId },
            },
            {
              type: 'tool-approval-request' as const,
              approvalId: `approval_delete_${sequence}`,
              toolCallId: `call_delete_${sequence}`,
            },
          ],
        },
      ],
    },
  })

  test('a turn lets the responder create a user-owned task and records the effect', async () => {
    const { ctx, userId, thread } = await setup()
    await ctx.db.insert(agentMessages).values({
      threadId: thread.id,
      userId,
      role: 'user',
      content: 'Add book flights',
    })

    await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async ({ tools }) => {
        await tools.createTask({ title: 'Book flights' })
        return completed('Added “Book flights”.')
      },
    )

    const ownedTasks = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, userId))
      .all()
    expect(ownedTasks).toHaveLength(1)
    expect(ownedTasks[0]?.title).toBe('Book flights')

    const calls = await ctx.db.select().from(agentToolCalls).all()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tool: 'createTask',
      status: 'done',
    })

    const runs = await ctx.db.select().from(agentRuns).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('complete')

    const messages = await ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, thread.id))
      .all()
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Added “Book flights”.',
    })

    const savedThread = await ctx.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, thread.id))
      .get()
    expect(savedThread?.status).toBe('idle')
  })

  test('persists an upstream provider activity as a completed visible step', async () => {
    const { ctx, userId, thread } = await setup()
    await ctx.db.insert(agentMessages).values({
      threadId: thread.id,
      userId,
      role: 'user',
      content: 'Calculate BMI',
    })

    await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async ({ stream }) => {
        await stream.writeActivity({
          kind: 'tool_call',
          title: 'BMI',
          output: { ok: true, values: { result: 24.2 } },
        })
        return completed('BMI is 24.2.')
      },
    )

    expect(await ctx.db.select().from(agentRunSteps).get()).toMatchObject({
      kind: 'tool_call',
      title: 'BMI',
      status: 'complete',
      visibility: 'visible',
      output: { ok: true, values: { result: 24.2 } },
    })
  })

  test('streams into the reserved draft and completes the same message', async () => {
    const state = await setup()
    const accepted = await acceptUserMessage(state.ctx, {
      userId: state.userId,
      content: 'List tasks',
      clientMessageId: 'browser-stream-1',
    })

    await runAgentTurn(
      state.ctx,
      {
        threadId: state.thread.id,
        reason: 'message',
        runId: accepted.runId,
        executionKey: accepted.runId,
      },
      async (input) => {
        expect(input.messages.at(-1)).toMatchObject({
          role: 'user',
          content: 'List tasks',
        })
        await input.stream.writeTextDelta('Three')
        await input.stream.writeTextDelta(' tasks.')
        return completed('Three tasks.')
      },
    )

    expect(
      await state.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, accepted.assistantMessageId))
        .get(),
    ).toMatchObject({
      content: 'Three tasks.',
      status: 'complete',
      revision: expect.any(Number),
    })
    expect(await state.ctx.db.select().from(agentMessages).all()).toHaveLength(2)
    expect(await state.ctx.db.select().from(agentRuns).get()).toMatchObject({
      id: accepted.runId,
      status: 'complete',
    })
  })

  test('links an exact visible tool step to the execution journal', async () => {
    const state = await setup()
    const accepted = await acceptUserMessage(state.ctx, {
      userId: state.userId,
      content: 'Add book flights',
      clientMessageId: 'browser-tool-1',
    })

    await runAgentTurn(
      state.ctx,
      {
        threadId: state.thread.id,
        reason: 'message',
        runId: accepted.runId,
        executionKey: accepted.runId,
      },
      async (input) => {
        await input.tools.createTask({ title: 'Book flights' })
        return completed('Added “Book flights”.')
      },
    )

    const call = await state.ctx.db.select().from(agentToolCalls).get()
    expect(await state.ctx.db.select().from(agentRunSteps).all()).toMatchObject([
      {
        runId: accepted.runId,
        sequence: 1,
        kind: 'tool_call',
        title: 'createTask v1',
        status: 'complete',
        visibility: 'visible',
        input: { title: 'Book flights' },
        output: { title: 'Book flights' },
        toolCallId: call!.id,
      },
    ])
  })

  test('preserves partial streamed text and completed steps when the responder fails', async () => {
    const state = await setup()
    const accepted = await acceptUserMessage(state.ctx, {
      userId: state.userId,
      content: 'Work then fail',
      clientMessageId: 'browser-error-1',
    })

    await expect(
      runAgentTurn(
        state.ctx,
        {
          threadId: state.thread.id,
          reason: 'message',
          runId: accepted.runId,
          executionKey: accepted.runId,
        },
        async (input) => {
          await input.stream.writeStatus('Inspecting tasks')
          await input.stream.writeTextDelta('Partial answer')
          throw new Error('model unavailable')
        },
      ),
    ).rejects.toThrow('model unavailable')

    expect(
      await state.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, accepted.assistantMessageId))
        .get(),
    ).toMatchObject({ content: 'Partial answer', status: 'error' })
    expect(await state.ctx.db.select().from(agentRuns).get()).toMatchObject({
      status: 'error',
      error: 'model unavailable',
    })
    expect(await state.ctx.db.select().from(agentRunSteps).all()).toMatchObject([
      { title: 'Inspecting tasks', status: 'complete' },
    ])
  })

  test('cancels a silent responder after the durable stop request', async () => {
    const state = await setup()
    const accepted = await acceptUserMessage(state.ctx, {
      userId: state.userId,
      content: 'Wait for provider',
      clientMessageId: 'browser-silent-stop',
    })
    const started = Promise.withResolvers<void>()

    const running = runAgentTurn(
      state.ctx,
      {
        threadId: state.thread.id,
        reason: 'message',
        runId: accepted.runId,
        executionKey: accepted.runId,
      },
      async (input) => {
        started.resolve()
        await new Promise<never>((_resolve, reject) => {
          input.stream.signal.addEventListener(
            'abort',
            () => reject(input.stream.signal.reason),
            { once: true },
          )
        })
        throw new Error('unreachable')
      },
    )
    await started.promise
    await requestRunCancellation(state.ctx, {
      runId: accepted.runId,
      userId: state.userId,
    })

    const result = await Promise.race([
      running,
      Bun.sleep(1_000).then(() => {
        throw new Error('cancellation monitor timed out')
      }),
    ])
    expect(result).toEqual({ status: 'cancelled' })
    expect(await state.ctx.db.select().from(agentRuns).get()).toMatchObject({
      status: 'cancelled',
    })
    expect(
      await state.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, accepted.assistantMessageId))
        .get(),
    ).toMatchObject({ status: 'cancelled' })
  })

  test('a commitment becomes an exact future job and a journal entry', async () => {
    const { ctx, enqueued, thread } = await setup()
    const dueAt = new Date('2026-08-25T09:30:00.000Z')

    await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async ({ tools }) => {
        await tools.createCommitment({
          title: 'Check the oven',
          dueAt: dueAt.toISOString(),
          execution: { kind: 'notify', message: 'Check the oven' },
        })
        return completed('I will remind you.')
      },
    )

    expect(enqueued).toContainEqual({
      name: 'agentCommitment',
      input: expect.any(Object),
      options: { dedupeKey: expect.any(String), runAt: dueAt },
    })
    expect(await ctx.db.select().from(agentCommitments).all()).toHaveLength(1)
    expect((await ctx.db.select().from(agentToolCalls).all())[0]).toMatchObject(
      { tool: 'createCommitment', status: 'done' },
    )
  })

  test('firing a commitment emits one declared reminder event and is idempotent', async () => {
    const { ctx, enqueued, thread, userId } = await setup()
    const [commitment] = await ctx.db
      .insert(agentCommitments)
      .values({
        threadId: thread.id,
        userId,
        kind: 'reminder',
        title: 'Check the oven',
        dueAt: new Date('2026-08-25T09:30:00.000Z'),
      })
      .returning()

    expect(await fireCommitment(ctx, commitment!.id)).toBe(true)
    expect(await fireCommitment(ctx, commitment!.id)).toBe(false)

    expect(await ctx.db.select().from(agentMessages).all()).toHaveLength(0)
    expect(await ctx.db.select().from(agentInbox).all()).toMatchObject([
      {
        threadId: thread.id,
        userId,
        type: 'task.reminder_due',
        payload: { commitmentId: commitment!.id, title: 'Check the oven' },
        delivery: 'immediate',
        status: 'pending',
      },
    ])
    expect(enqueued.at(-1)).toMatchObject({
      name: 'agentTurn',
      input: { threadId: thread.id, reason: 'event:task.reminder_due' },
    })
  })

  test('wake increments the durable sequence and uses a stable dedupe key', async () => {
    const { ctx, enqueued, thread } = await setup()

    await wakeAgent(ctx, thread.id, 'message')

    const saved = await ctx.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, thread.id))
      .get()
    expect(saved?.wakeSeq).toBe(1)
    expect(enqueued.at(-1)).toEqual({
      name: 'agentTurn',
      input: {
        threadId: thread.id,
        reason: 'message',
        executionKey: expect.any(String),
      },
      options: { dedupeKey: `agent-turn:${thread.id}` },
    })
  })

  test('a wake received during a turn queues a recovery turn with a non-conflicting key', async () => {
    const { ctx, enqueued, thread } = await setup()

    await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async () => {
        await wakeAgent(ctx, thread.id, 'message.during_turn')
        return completed('First turn finished.')
      },
    )

    expect(enqueued.at(-1)).toEqual({
      name: 'agentTurn',
      input: {
        threadId: thread.id,
        reason: 'wake.during_turn',
        executionKey: expect.any(String),
      },
      options: { dedupeKey: `agent-turn:${thread.id}:wake:1` },
    })
  })

  test('a job retry keeps its execution identity across a concurrent wake', async () => {
    const { ctx, thread } = await setup()
    const input = {
      threadId: thread.id,
      reason: 'message',
      executionKey: 'durable-turn-1',
    }

    await expect(
      runAgentTurn(ctx, input, async (agent) => {
        await agent.tools.createTask({ title: 'Do not duplicate' })
        await wakeAgent(ctx, thread.id, 'message.during_turn')
        throw new Error('model failed after tool success')
      }),
    ).rejects.toThrow('model failed after tool success')

    await runAgentTurn(ctx, input, async (agent) => {
      await agent.tools.createTask({ title: 'Do not duplicate' })
      return completed('Recovered.')
    })
    expect(
      await ctx.db
        .select()
        .from(tasks)
        .where(eq(tasks.title, 'Do not duplicate')),
    ).toHaveLength(1)
  })

  test('a successful turn consumes selected inbox but a failed turn leaves it pending', async () => {
    const success = await setup()
    await success.ctx.db.insert(agentInbox).values({
      threadId: success.thread.id,
      userId: success.userId,
      type: 'subscription.limit_near',
      payload: { remaining: 2 },
      delivery: 'next_turn',
      aggregate: 'latest',
    })
    await runAgentTurn(
      success.ctx,
      { threadId: success.thread.id, reason: 'message' },
      async () => completed('Noted.'),
    )
    expect(await success.ctx.db.select().from(agentInbox).get()).toMatchObject({
      status: 'consumed',
    })

    const failure = await setup()
    await failure.ctx.db.insert(agentInbox).values({
      threadId: failure.thread.id,
      userId: failure.userId,
      type: 'subscription.limit_near',
      payload: { remaining: 1 },
      delivery: 'next_turn',
      aggregate: 'latest',
    })
    await expect(
      runAgentTurn(
        failure.ctx,
        { threadId: failure.thread.id, reason: 'message' },
        async () => {
          throw new Error('model unavailable')
        },
      ),
    ).rejects.toThrow('model unavailable')
    expect(
      await failure.ctx.db
        .select()
        .from(agentInbox)
        .where(eq(agentInbox.userId, failure.userId))
        .get(),
    ).toMatchObject({ status: 'pending' })
  })

  test('an intentional empty response does not create an assistant message', async () => {
    const { ctx, thread } = await setup()

    await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'system.maintenance' },
      async () => completed(''),
    )

    expect(await ctx.db.select().from(agentMessages).all()).toHaveLength(0)
  })

  test('an approval request suspends the run without a final assistant message', async () => {
    const { ctx, thread, userId } = await setup()
    const [task] = await ctx.db
      .insert(tasks)
      .values({ userId, title: 'Book flights' })
      .returning()
    await ctx.db.insert(agentMessages).values({
      threadId: thread.id,
      userId,
      role: 'user',
      content: 'Delete book flights',
    })

    const result = await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async () => waiting(task!.id),
    )

    expect(result.status).toBe('waiting_for_approval')
    expect(await ctx.db.select().from(agentRuns).all()).toMatchObject([
      {
        status: 'waiting_for_approval',
        checkpoint: { messages: expect.any(Array) },
        completedAt: null,
      },
    ])
    expect(await ctx.db.select().from(agentRequests).all()).toMatchObject([
      {
        status: 'pending',
        approvalId: 'approval_delete_1',
        toolCallId: 'call_delete_1',
        tool: 'deleteTask',
        args: { taskId: task!.id },
      },
    ])
    expect(await ctx.db.select().from(agentMessages).all()).toHaveLength(1)
    expect(
      await ctx.db
        .select()
        .from(agentThreads)
        .where(eq(agentThreads.id, thread.id))
        .get(),
    ).toMatchObject({ status: 'idle', lockedAt: null })
  })

  test('approval resumes the same run and executes the frozen call exactly once', async () => {
    const { ctx, enqueued, thread, userId } = await setup()
    const [task] = await ctx.db
      .insert(tasks)
      .values({ userId, title: 'Book flights' })
      .returning()
    await ctx.db.insert(agentMessages).values({
      threadId: thread.id,
      userId,
      role: 'user',
      content: 'Delete book flights',
    })
    const suspended = await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async () => waiting(task!.id),
    )
    if (suspended.status !== 'waiting_for_approval') {
      throw new Error('approval checkpoint expected')
    }

    const decision = await resolveApproval(ctx, {
      requestId: suspended.requestId,
      userId,
      decision: 'allow_once',
    })

    expect(decision.status).toBe('resuming')
    expect(await ctx.db.select().from(tasks).all()).toHaveLength(1)
    expect(await ctx.db.select().from(agentToolCalls).all()).toHaveLength(0)
    expect(enqueued.at(-1)).toEqual({
      name: 'agentTurn',
      input: {
        threadId: thread.id,
        reason: 'tool.approval_resolved',
        runId: suspended.runId,
        requestId: suspended.requestId,
      },
      options: {
        dedupeKey: `agent-run:${suspended.runId}:resume:${suspended.requestId}`,
      },
    })

    await runAgentTurn(
      ctx,
      enqueued.at(-1)!.input as {
        threadId: string
        reason: string
        runId: string
        requestId: string
      },
      async (input) => {
        expect(input.approvalResponse).toMatchObject({
          approvalId: 'approval_delete_1',
          approved: true,
        })
        expect(input.checkpoint?.messages).toHaveLength(2)
        await input.tools.deleteTask({ taskId: task!.id })
        return completed('Deleted “Book flights”.')
      },
    )

    expect(await ctx.db.select().from(agentRuns).all()).toMatchObject([
      { id: suspended.runId, status: 'complete' },
    ])
    expect(await ctx.db.select().from(tasks).all()).toHaveLength(0)
    expect(await ctx.db.select().from(agentToolCalls).all()).toHaveLength(1)
    expect(await ctx.db.select().from(agentMessages).all()).toMatchObject([
      { role: 'user', content: 'Delete book flights' },
      { role: 'assistant', content: 'Deleted “Book flights”.' },
    ])
  })

  test('sequential approvals suspend and resume one logical run repeatedly', async () => {
    const { ctx, thread, userId } = await setup()
    const seededTasks = await ctx.db
      .insert(tasks)
      .values([
        { userId, title: 'First task' },
        { userId, title: 'Second task' },
      ])
      .returning()
    const first = await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async () => waiting(seededTasks[0]!.id, 1),
    )
    if (first.status !== 'waiting_for_approval')
      throw new Error('first approval expected')
    await resolveApproval(ctx, {
      requestId: first.requestId,
      userId,
      decision: 'allow_once',
    })

    const second = await runAgentTurn(
      ctx,
      {
        threadId: thread.id,
        reason: 'tool.approval_resolved',
        runId: first.runId,
        requestId: first.requestId,
      },
      async (input) => {
        await input.tools.deleteTask({ taskId: seededTasks[0]!.id })
        return waiting(seededTasks[1]!.id, 2)
      },
    )
    if (second.status !== 'waiting_for_approval')
      throw new Error('second approval expected')

    expect(second.runId).toBe(first.runId)
    expect(await ctx.db.select().from(agentRuns).all()).toMatchObject([
      { id: first.runId, status: 'waiting_for_approval' },
    ])
    expect(await ctx.db.select().from(agentRequests).all()).toHaveLength(2)
    expect(await ctx.db.select().from(agentToolCalls).all()).toHaveLength(1)

    await resolveApproval(ctx, {
      requestId: second.requestId,
      userId,
      decision: 'allow_once',
    })
    await runAgentTurn(
      ctx,
      {
        threadId: thread.id,
        reason: 'tool.approval_resolved',
        runId: second.runId,
        requestId: second.requestId,
      },
      async (input) => {
        await input.tools.deleteTask({ taskId: seededTasks[1]!.id })
        return completed('Deleted both tasks.')
      },
    )

    expect(await ctx.db.select().from(agentRuns).all()).toMatchObject([
      { id: first.runId, status: 'complete' },
    ])
    expect(await ctx.db.select().from(tasks).all()).toHaveLength(0)
    expect(await ctx.db.select().from(agentToolCalls).all()).toHaveLength(2)
  })

  test('rejection resumes the same run without executing the frozen tool', async () => {
    const { ctx, thread, userId } = await setup()
    const [task] = await ctx.db
      .insert(tasks)
      .values({ userId, title: 'Keep me' })
      .returning()
    const suspended = await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async () => waiting(task!.id),
    )
    if (suspended.status !== 'waiting_for_approval')
      throw new Error('approval expected')
    await resolveApproval(ctx, {
      requestId: suspended.requestId,
      userId,
      decision: 'reject',
    })

    await runAgentTurn(
      ctx,
      {
        threadId: thread.id,
        reason: 'tool.approval_resolved',
        runId: suspended.runId,
        requestId: suspended.requestId,
      },
      async (input) => {
        expect(input.approvalResponse).toMatchObject({ approved: false })
        return completed('I did not delete the task.')
      },
    )

    expect(await ctx.db.select().from(agentRuns).all()).toMatchObject([
      { id: suspended.runId, status: 'complete' },
    ])
    expect(await ctx.db.select().from(tasks).all()).toHaveLength(1)
    expect(await ctx.db.select().from(agentToolCalls).all()).toHaveLength(0)
  })
})
