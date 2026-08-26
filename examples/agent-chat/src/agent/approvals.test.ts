import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import {
  agentRequests,
  agentRuns,
  agentToolCalls,
  agentToolGrants,
  tasks,
} from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import {
  invokeAgentTool,
  resolveApproval,
  revokeToolGrant,
} from './approvals'
import { getOrCreateThread } from './runtime'

describe('tool approvals', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((testApp) => testApp.close()))
  })

  async function setup(name = 'Alice') {
    const testApp = await createTestApp()
    apps.push(testApp)
    const userId = await testApp.seedUser(name)
    const thread = await getOrCreateThread(testApp.ctx.db, userId)
    const [run] = await testApp.ctx.db
      .insert(agentRuns)
      .values({
        threadId: thread.id,
        userId,
        reason: 'message',
        status: 'running',
      })
      .returning()
    const [task] = await testApp.ctx.db
      .insert(tasks)
      .values({ userId, title: 'Remove me' })
      .returning()
    return { ...testApp, userId, thread, run: run!, task: task! }
  }

  const invokeDelete = (
    state: Awaited<ReturnType<typeof setup>>,
    taskId = state.task.id,
  ) =>
    invokeAgentTool(state.ctx, {
      toolId: 'deleteTask',
      rawArgs: { taskId },
      userId: state.userId,
      threadId: state.thread.id,
      runId: state.run.id,
      trigger: { type: 'user', trusted: true },
    })

  test('deleteTask freezes a pending approval without performing the effect', async () => {
    const setupState = await setup()

    const result = await invokeDelete(setupState)

    expect(result).toMatchObject({ status: 'approval_required' })
    expect(await setupState.ctx.db.select().from(agentRequests).all()).toMatchObject([
      {
        status: 'pending',
        tool: 'deleteTask',
        toolVersion: 1,
        args: { taskId: setupState.task.id },
      },
    ])
    expect(await setupState.ctx.db.select().from(tasks).all()).toHaveLength(1)
    expect(await setupState.ctx.db.select().from(agentToolCalls).all()).toHaveLength(0)
  })

  test('allow_once executes the exact frozen call once and replay is inert', async () => {
    const setupState = await setup()
    const pending = await invokeDelete(setupState)
    if (pending.status !== 'approval_required') throw new Error('approval expected')

    const first = await resolveApproval(setupState.ctx, {
      requestId: pending.requestId,
      userId: setupState.userId,
      decision: 'allow_once',
    })
    const replay = await resolveApproval(setupState.ctx, {
      requestId: pending.requestId,
      userId: setupState.userId,
      decision: 'allow_once',
    })

    expect(first.status).toBe('executed')
    expect(replay.status).toBe('already_resolved')
    expect(await setupState.ctx.db.select().from(tasks).all()).toHaveLength(0)
    expect(await setupState.ctx.db.select().from(agentToolCalls).all()).toHaveLength(1)
  })

  test('always_allow creates a reusable grant and later calls update its usage', async () => {
    const setupState = await setup()
    const pending = await invokeDelete(setupState)
    if (pending.status !== 'approval_required') throw new Error('approval expected')
    await resolveApproval(setupState.ctx, {
      requestId: pending.requestId,
      userId: setupState.userId,
      decision: 'always_allow',
    })
    const [grant] = await setupState.ctx.db.select().from(agentToolGrants).all()
    expect(grant).toMatchObject({
      userId: setupState.userId,
      threadId: setupState.thread.id,
      tool: 'deleteTask',
      toolVersion: 1,
      status: 'active',
    })

    const [secondTask] = await setupState.ctx.db
      .insert(tasks)
      .values({ userId: setupState.userId, title: 'Remove me too' })
      .returning()
    const result = await invokeDelete(setupState, secondTask!.id)
    expect(result.status).toBe('done')
    const usedGrant = await setupState.ctx.db
      .select()
      .from(agentToolGrants)
      .where(eq(agentToolGrants.id, grant!.id))
      .get()
    expect(usedGrant?.lastUsedAt).toBeInstanceOf(Date)
  })

  test('revoking a grant requires approval again', async () => {
    const setupState = await setup()
    const pending = await invokeDelete(setupState)
    if (pending.status !== 'approval_required') throw new Error('approval expected')
    await resolveApproval(setupState.ctx, {
      requestId: pending.requestId,
      userId: setupState.userId,
      decision: 'always_allow',
    })
    const [grant] = await setupState.ctx.db.select().from(agentToolGrants).all()
    await revokeToolGrant(setupState.ctx, {
      grantId: grant!.id,
      userId: setupState.userId,
    })
    const [nextTask] = await setupState.ctx.db
      .insert(tasks)
      .values({ userId: setupState.userId, title: 'Ask again' })
      .returning()

    expect((await invokeDelete(setupState, nextTask!.id)).status).toBe(
      'approval_required',
    )
    expect(
      await setupState.ctx.db
        .select()
        .from(agentToolGrants)
        .where(
          and(
            eq(agentToolGrants.id, grant!.id),
            eq(agentToolGrants.status, 'revoked'),
          ),
        )
        .get(),
    ).toBeDefined()
  })

  test('one user cannot resolve another user’s request', async () => {
    const alice = await setup('Alice')
    const pending = await invokeDelete(alice)
    if (pending.status !== 'approval_required') throw new Error('approval expected')
    const bobId = await alice.seedUser('Bob')

    await expect(
      resolveApproval(alice.ctx, {
        requestId: pending.requestId,
        userId: bobId,
        decision: 'reject',
      }),
    ).rejects.toThrow('Approval request not found')
  })
})
