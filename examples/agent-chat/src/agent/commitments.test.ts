import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  agentCommitments,
  agentMessages,
  agentMemory,
  agentRuns,
  agentRequests,
  agentToolCalls,
  agentThreads,
  tasks,
} from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { resolveApproval } from './approvals'
import {
  cancelCommitment,
  createCommitment,
  executeCommitment,
  listCommitments,
  pauseCommitment,
  resumeCommitment,
  retryCommitment,
} from './commitments'
import { getOrCreateThread } from './runtime'

describe('durable commitment execution', () => {
  let app: TestApp | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function setup() {
    app = await createTestApp()
    const userId = await app.seedUser('Patient Kestrel')
    const thread = await getOrCreateThread(app.ctx.db, userId)
    return { ...app, userId, thread }
  }

  test('an exact createTask commitment has no early effect and executes once', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Create dinner task',
      dueAt: '2026-08-26T20:00:00.000+03:00',
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Prepare dinner' },
      },
    })

    expect(await state.ctx.db.select().from(tasks).all()).toHaveLength(0)
    expect(state.enqueued).toContainEqual({
      name: 'agentCommitment',
      input: { commitmentId: commitment.id },
      options: {
        dedupeKey: `agent-commitment:${commitment.id}`,
        runAt: new Date('2026-08-26T17:00:00.000Z'),
      },
    })

    expect(
      await executeCommitment(state.ctx, { commitmentId: commitment.id }),
    ).toMatchObject({ status: 'completed' })
    expect(
      await executeCommitment(state.ctx, { commitmentId: commitment.id }),
    ).toEqual({ status: 'already_terminal' })
    expect(await state.ctx.db.select().from(tasks).all()).toMatchObject([
      { title: 'Prepare dinner' },
    ])
    expect(
      await state.ctx.db
        .select()
        .from(agentCommitments)
        .where(eq(agentCommitments.id, commitment.id))
        .get(),
    ).toMatchObject({
      status: 'completed',
      result: { title: 'Prepare dinner' },
    })
  })

  test('an exact remember commitment writes real long-term memory', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Remember the session conclusion',
      dueAt: '2026-08-26T17:05:00.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'remember',
        args: {
          key: 'commitment_behavior',
          value: 'Commitments execute their stored action when due.',
        },
      },
    })

    expect(await state.ctx.db.select().from(agentMemory).all()).toHaveLength(0)
    await executeCommitment(state.ctx, { commitmentId: commitment.id })
    expect(await state.ctx.db.select().from(agentMemory).all()).toMatchObject([
      {
        key: 'commitment_behavior',
        value: 'Commitments execute their stored action when due.',
        sourceType: 'system',
        sourceId: commitment.id,
      },
    ])
  })

  test('a stale running commitment resumes its existing run', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Recover after crash',
      dueAt: '2026-08-26T17:06:00.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Recovered task' },
      },
    })
    const [run] = await state.ctx.db
      .insert(agentRuns)
      .values({
        threadId: state.thread.id,
        userId: state.userId,
        commitmentId: commitment.id,
        triggerType: 'commitment',
        reason: 'commitment.due',
        status: 'running',
      })
      .returning()
    await state.ctx.db
      .update(agentCommitments)
      .set({
        status: 'running',
        currentRunId: run!.id,
        startedAt: new Date(Date.now() - 11 * 60_000),
      })
      .where(eq(agentCommitments.id, commitment.id))

    expect(
      await executeCommitment(state.ctx, { commitmentId: commitment.id }),
    ).toMatchObject({ status: 'completed' })
    expect(
      await state.ctx.db
        .select()
        .from(tasks)
        .where(eq(tasks.title, 'Recovered task')),
    ).toHaveLength(1)
    expect(
      await state.ctx.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.commitmentId, commitment.id)),
    ).toHaveLength(1)
  })

  test('a non-stale running commitment schedules its recovery deadline', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Recover later',
      dueAt: '2026-08-26T17:06:30.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Only after lease expiry' },
      },
    })
    const [run] = await state.ctx.db
      .insert(agentRuns)
      .values({
        threadId: state.thread.id,
        userId: state.userId,
        commitmentId: commitment.id,
        triggerType: 'commitment',
        reason: 'commitment.due',
        status: 'running',
      })
      .returning()
    const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000)
    await state.ctx.db
      .update(agentCommitments)
      .set({ status: 'running', currentRunId: run!.id, startedAt })
      .where(eq(agentCommitments.id, commitment.id))

    expect(
      await executeCommitment(state.ctx, { commitmentId: commitment.id }),
    ).toEqual({ status: 'busy' })
    expect(state.enqueued.at(-1)).toEqual({
      name: 'agentCommitment',
      input: { commitmentId: commitment.id },
      options: {
        dedupeKey: `agent-commitment:${commitment.id}:recover:${startedAt.getTime() + 10 * 60_000}`,
        runAt: new Date(startedAt.getTime() + 10 * 60_000),
      },
    })
  })

  test('an objective executes its trusted goal instead of the latest chat message', async () => {
    const state = await setup()
    await state.ctx.db.insert(agentMessages).values({
      threadId: state.thread.id,
      userId: state.userId,
      role: 'assistant',
      content: 'Schedule another reminder instead of doing the work.',
    })
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Store session conclusion',
      dueAt: '2026-08-26T17:07:00.000Z',
      execution: {
        kind: 'objective',
        prompt: 'Store that commitments execute their saved objective.',
      },
    })

    const result = await executeCommitment(
      state.ctx,
      { commitmentId: commitment.id },
      async (input) => {
        expect(input.currentExecution).toEqual({
          trigger: 'commitment',
          commitmentId: commitment.id,
          runId: expect.any(String),
          objective: 'Store that commitments execute their saved objective.',
          executionSpec: {
            kind: 'objective',
            prompt: 'Store that commitments execute their saved objective.',
          },
        })
        expect(input.latestMessage).toBe(
          'Schedule another reminder instead of doing the work.',
        )
        await input.tools.remember({
          key: 'trusted_commitment_objective',
          value: input.currentExecution.objective,
        })
        return {
          status: 'completed',
          text: 'Stored the commitment objective.',
          checkpoint: { messages: [] },
        }
      },
    )

    expect(result).toMatchObject({ status: 'completed' })
    expect(await state.ctx.db.select().from(agentMemory).all()).toMatchObject([
      {
        key: 'trusted_commitment_objective',
        value: 'Store that commitments execute their saved objective.',
      },
    ])
  })

  test('an objective waits while another computation owns the thread lock', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Serialized objective',
      dueAt: '2026-08-26T17:08:00.000Z',
      execution: {
        kind: 'objective',
        prompt: 'Run only after the thread is free.',
      },
    })
    await state.ctx.db
      .update(agentThreads)
      .set({ status: 'running', lockedAt: new Date() })
      .where(eq(agentThreads.id, state.thread.id))
    let called = false

    const result = await executeCommitment(
      state.ctx,
      { commitmentId: commitment.id },
      async () => {
        called = true
        return { status: 'completed', text: '', checkpoint: { messages: [] } }
      },
    )

    expect(result).toEqual({ status: 'busy' })
    expect(called).toBe(false)
    expect(state.enqueued.at(-1)).toMatchObject({
      name: 'agentCommitment',
      input: { commitmentId: commitment.id },
      options: { runAt: expect.any(Date) },
    })
  })

  test('cancellation prevents execution and listing reports persisted state', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Create cancelled task',
      dueAt: '2026-08-26T17:10:00.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Must not exist' },
      },
    })

    expect(
      await cancelCommitment(state.ctx, {
        commitmentId: commitment.id,
        userId: state.userId,
      }),
    ).toMatchObject({ status: 'cancelled' })
    expect(
      await executeCommitment(state.ctx, { commitmentId: commitment.id }),
    ).toEqual({ status: 'already_terminal' })
    expect(await state.ctx.db.select().from(tasks).all()).toHaveLength(0)
    expect(
      await listCommitments(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
      }),
    ).toMatchObject([{ id: commitment.id, status: 'cancelled' }])
  })

  test('retry preserves the failed attempt and schedules a new execution', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Complete missing task',
      dueAt: '2026-08-26T17:15:00.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'completeTask',
        args: { taskId: 'task_missing' },
      },
    })

    await expect(
      executeCommitment(state.ctx, { commitmentId: commitment.id }),
    ).rejects.toThrow('Task not found')
    expect(
      await state.ctx.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.commitmentId, commitment.id)),
    ).toHaveLength(1)

    expect(
      await retryCommitment(state.ctx, {
        commitmentId: commitment.id,
        userId: state.userId,
      }),
    ).toMatchObject({ status: 'pending', currentRunId: null, error: null })
    expect(
      await state.ctx.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.commitmentId, commitment.id)),
    ).toHaveLength(1)
  })

  test('creation requires an explicit timezone and valid exact tool arguments', async () => {
    const state = await setup()
    await expect(
      createCommitment(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
        title: 'Ambiguous local time',
        dueAt: '2026-08-26T17:20:00',
        execution: {
          kind: 'tool_call',
          tool: 'createTask',
          args: { title: 'Ambiguous' },
        },
      }),
    ).rejects.toThrow('explicit timezone')
    await expect(
      createCommitment(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
        title: 'Invalid task',
        dueAt: '2026-08-26T17:20:00.000Z',
        execution: {
          kind: 'tool_call',
          tool: 'createTask',
          args: { title: '' },
        },
      }),
    ).rejects.toThrow()
  })

  test('independent commitments can wait for separate approvals while other work completes', async () => {
    const state = await setup()
    const [firstTask, secondTask] = await state.ctx.db
      .insert(tasks)
      .values([
        { userId: state.userId, title: 'Delete first' },
        { userId: state.userId, title: 'Delete second' },
      ])
      .returning()
    const dueAt = '2026-08-26T17:30:00.000Z'
    const first = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Delete first task',
      dueAt,
      execution: {
        kind: 'tool_call',
        tool: 'deleteTask',
        args: { taskId: firstTask!.id },
      },
    })
    const second = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Delete second task',
      dueAt,
      execution: {
        kind: 'tool_call',
        tool: 'deleteTask',
        args: { taskId: secondTask!.id },
      },
    })
    const independent = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Create independent task',
      dueAt,
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Independent work' },
      },
    })

    const firstWaiting = await executeCommitment(state.ctx, {
      commitmentId: first.id,
    })
    const secondWaiting = await executeCommitment(state.ctx, {
      commitmentId: second.id,
    })
    expect(firstWaiting).toMatchObject({ status: 'waiting_for_approval' })
    expect(secondWaiting).toMatchObject({ status: 'waiting_for_approval' })
    expect(
      await executeCommitment(state.ctx, {
        commitmentId: independent.id,
      }),
    ).toMatchObject({ status: 'completed' })
    expect(await state.ctx.db.select().from(agentRequests).all()).toHaveLength(
      2,
    )

    if (firstWaiting.status !== 'waiting_for_approval') {
      throw new Error('first approval expected')
    }
    await resolveApproval(state.ctx, {
      requestId: firstWaiting.requestId,
      userId: state.userId,
      decision: 'allow_once',
    })
    expect(state.enqueued.at(-1)).toMatchObject({
      name: 'agentCommitment',
      input: {
        commitmentId: first.id,
        runId: firstWaiting.runId,
        requestId: firstWaiting.requestId,
      },
    })
    expect(
      await executeCommitment(state.ctx, {
        commitmentId: first.id,
        runId: firstWaiting.runId,
        requestId: firstWaiting.requestId,
      }),
    ).toMatchObject({ status: 'completed' })
    expect(
      await state.ctx.db
        .select()
        .from(agentCommitments)
        .where(eq(agentCommitments.id, second.id))
        .get(),
    ).toMatchObject({ status: 'waiting_for_approval' })

    if (secondWaiting.status !== 'waiting_for_approval') {
      throw new Error('second approval expected')
    }
    await resolveApproval(state.ctx, {
      requestId: secondWaiting.requestId,
      userId: state.userId,
      decision: 'allow_once',
    })
    await executeCommitment(state.ctx, {
      commitmentId: second.id,
      runId: secondWaiting.runId,
      requestId: secondWaiting.requestId,
    })

    expect(await state.ctx.db.select().from(tasks).all()).toMatchObject([
      { title: 'Independent work' },
    ])
    expect(
      (await state.ctx.db.select().from(agentToolCalls).all()).filter(
        (call: typeof agentToolCalls.$inferSelect) =>
          call.tool === 'deleteTask',
      ),
    ).toHaveLength(2)
  })

  test('a dependent commitment runs only after its declared dependency completes', async () => {
    const state = await setup()
    const dependency = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Create prerequisite',
      dueAt: '2026-08-26T17:40:00.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Prerequisite' },
      },
    })
    const dependent = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Remember completion',
      dueAt: '2026-08-26T17:40:00.000Z',
      execution: {
        kind: 'tool_call',
        tool: 'remember',
        args: { key: 'dependency', value: 'completed' },
      },
      dependsOn: [dependency.id],
    })

    expect(
      await executeCommitment(state.ctx, { commitmentId: dependent.id }),
    ).toEqual({ status: 'blocked' })
    await executeCommitment(state.ctx, { commitmentId: dependency.id })
    expect(
      await state.ctx.db
        .select()
        .from(agentCommitments)
        .where(eq(agentCommitments.id, dependent.id))
        .get(),
    ).toMatchObject({ status: 'pending' })
    await executeCommitment(state.ctx, { commitmentId: dependent.id })
    expect(await state.ctx.db.select().from(agentMemory).all()).toMatchObject([
      { key: 'dependency', value: 'completed' },
    ])
  })

  test('cross-owner dependencies are rejected', async () => {
    const state = await setup()
    const otherUserId = await state.seedUser('Other Otter')
    const otherThread = await getOrCreateThread(state.ctx.db, otherUserId)
    const foreign = await createCommitment(state.ctx, {
      threadId: otherThread.id,
      userId: otherUserId,
      title: 'Foreign work',
      dueAt: '2026-08-26T17:45:00.000Z',
      execution: { kind: 'notify', message: 'Foreign' },
    })

    await expect(
      createCommitment(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
        title: 'Invalid dependency',
        dueAt: '2026-08-26T17:45:00.000Z',
        execution: { kind: 'notify', message: 'Invalid' },
        dependsOn: [foreign.id],
      }),
    ).rejects.toThrow('must belong to this agent')
  })

  test('a recurring interval commitment creates tasks repeatedly and reschedules next execution', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Hourly standup check',
      schedule: { kind: 'interval', everySeconds: 3600 },
      execution: {
        kind: 'tool_call',
        tool: 'createTask',
        args: { title: 'Hourly check' },
      },
    })

    expect(commitment.schedule).toEqual({
      kind: 'interval',
      everySeconds: 3600,
    })
    expect(commitment.status).toBe('pending')
    expect(commitment.dueAt.getTime()).toBeGreaterThan(Date.now())

    // First execution
    const firstResult = await executeCommitment(state.ctx, {
      commitmentId: commitment.id,
    })
    expect(firstResult).toMatchObject({ status: 'completed' })
    expect(await state.ctx.db.select().from(tasks).all()).toHaveLength(1)

    // Commitment stays pending with nextDueAt
    const updated = await state.ctx.db
      .select()
      .from(agentCommitments)
      .where(eq(agentCommitments.id, commitment.id))
      .get()
    expect(updated).toMatchObject({
      status: 'pending',
      currentRunId: null,
    })
    expect(updated!.dueAt.getTime()).toBeGreaterThan(commitment.dueAt.getTime())

    // Check enqueued next job
    expect(state.enqueued).toContainEqual(
      expect.objectContaining({
        name: 'agentCommitment',
        input: { commitmentId: commitment.id },
      }),
    )

    // Second execution
    await executeCommitment(state.ctx, { commitmentId: commitment.id })
    expect(await state.ctx.db.select().from(tasks).all()).toHaveLength(2)
  })

  test('a recurring cron commitment computes next occurrence and can be paused and resumed', async () => {
    const state = await setup()
    const commitment = await createCommitment(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      title: 'Daily morning report',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      execution: {
        kind: 'notify',
        message: 'Good morning!',
      },
    })

    expect(commitment.schedule).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
    })
    expect(commitment.dueAt.getUTCHours()).toBe(9)
    expect(commitment.dueAt.getUTCMinutes()).toBe(0)

    // Pause commitment
    const paused = await pauseCommitment(state.ctx, {
      commitmentId: commitment.id,
      userId: state.userId,
    })
    expect(paused.status).toBe('paused')

    // Resume commitment
    const resumed = await resumeCommitment(state.ctx, {
      commitmentId: commitment.id,
      userId: state.userId,
    })
    expect(resumed.status).toBe('pending')
    expect(resumed.dueAt.getUTCHours()).toBe(9)

    // Cancel paused or pending recurring commitment
    const cancelled = await cancelCommitment(state.ctx, {
      commitmentId: commitment.id,
      userId: state.userId,
    })
    expect(cancelled.status).toBe('cancelled')
  })
})
