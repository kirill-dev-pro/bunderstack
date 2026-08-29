import { afterEach, describe, expect, test } from 'bun:test'
import { mockAuthSession } from 'bunderstack/testing'
import { eq } from 'drizzle-orm'

import { remember } from './agent/memory'
import { getOrCreateThread } from './agent/runtime'
import {
  agentMemory,
  agentRequests,
  agentRuns,
  agentToolGrants,
} from './schema'
import { createTestApp, type TestApp } from './test-app'

describe('protected agent actions', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function setup() {
    const app = await createTestApp()
    apps.push(app)
    const aliceId = await app.seedUser('Alice')
    const bobId = await app.seedUser('Bob')
    const aliceThread = await getOrCreateThread(app.ctx.db, aliceId)
    const bobThread = await getOrCreateThread(app.ctx.db, bobId)
    return { ...app, aliceId, bobId, aliceThread, bobThread }
  }

  const call = (
    app: TestApp['app'],
    path: string,
    method: string,
    body?: unknown,
  ) =>
    app.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
    )

  test('agent mutation endpoints reject anonymous HTTP callers', async () => {
    const state = await setup()

    const response = await call(
      state.app,
      '/api/agent/memory/amem_missing',
      'PATCH',
      { value: 'changed' },
    )

    expect(response.status).toBe(401)
  })

  test('a user cannot mutate another user’s memory, request, or grant', async () => {
    const state = await setup()
    const bobMemory = await remember(state.ctx, {
      userId: state.bobId,
      kind: 'fact',
      key: 'secret',
      value: 'bob-only',
      source: { type: 'user', trusted: true },
    })
    const [run] = await state.ctx.db
      .insert(agentRuns)
      .values({
        threadId: state.bobThread.id,
        userId: state.bobId,
        reason: 'message',
        status: 'running',
      })
      .returning()
    const [request] = await state.ctx.db
      .insert(agentRequests)
      .values({
        threadId: state.bobThread.id,
        userId: state.bobId,
        runId: run!.id,
        kind: 'approval',
        prompt: 'Approve?',
        tool: 'deleteTask',
        toolVersion: 1,
        args: { taskId: 'task_missing' },
        approvalId: 'approval_bob_delete',
        toolCallId: 'call_bob_delete',
      })
      .returning()
    const [grant] = await state.ctx.db
      .insert(agentToolGrants)
      .values({
        threadId: state.bobThread.id,
        userId: state.bobId,
        tool: 'deleteTask',
        toolVersion: 1,
        scope: {},
      })
      .returning()
    mockAuthSession(state.app, async () => ({
      user: { id: state.aliceId, email: 'alice@example.test', name: 'Alice' },
    }))

    const responses = await Promise.all([
      call(state.app, `/api/agent/memory/${bobMemory.id}`, 'PATCH', {
        value: 'stolen',
      }),
      call(state.app, `/api/agent/memory/${bobMemory.id}`, 'DELETE'),
      call(state.app, `/api/agent/approvals/${request!.id}`, 'POST', {
        decision: 'reject',
      }),
      call(state.app, `/api/agent/grants/${grant!.id}/revoke`, 'POST'),
    ])
    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404,
    ])
    expect(
      await state.ctx.db
        .select()
        .from(agentMemory)
        .where(eq(agentMemory.id, bobMemory.id))
        .get(),
    ).toMatchObject({ value: 'bob-only' })
    expect(
      await state.ctx.db
        .select()
        .from(agentRequests)
        .where(eq(agentRequests.id, request!.id))
        .get(),
    ).toMatchObject({ status: 'pending' })
    expect(
      await state.ctx.db
        .select()
        .from(agentToolGrants)
        .where(eq(agentToolGrants.id, grant!.id))
        .get(),
    ).toMatchObject({ status: 'active' })
  })

  test('the owner can edit, delete, reject, and revoke through thin actions', async () => {
    const state = await setup()
    mockAuthSession(state.app, async () => ({
      user: { id: state.aliceId, email: 'alice@example.test', name: 'Alice' },
    }))
    const memory = await remember(state.ctx, {
      userId: state.aliceId,
      kind: 'fact',
      key: 'tone',
      value: 'brief',
      source: { type: 'user', trusted: true },
    })
    const [run] = await state.ctx.db
      .insert(agentRuns)
      .values({
        threadId: state.aliceThread.id,
        userId: state.aliceId,
        reason: 'message',
        status: 'running',
      })
      .returning()
    const [request] = await state.ctx.db
      .insert(agentRequests)
      .values({
        threadId: state.aliceThread.id,
        userId: state.aliceId,
        runId: run!.id,
        kind: 'approval',
        prompt: 'Approve?',
        tool: 'deleteTask',
        toolVersion: 1,
        args: { taskId: 'task_missing' },
        approvalId: 'approval_alice_delete',
        toolCallId: 'call_alice_delete',
      })
      .returning()
    const [grant] = await state.ctx.db
      .insert(agentToolGrants)
      .values({
        threadId: state.aliceThread.id,
        userId: state.aliceId,
        tool: 'deleteTask',
        toolVersion: 1,
        scope: {},
      })
      .returning()

    expect(
      (
        await call(state.app, `/api/agent/memory/${memory.id}`, 'PATCH', {
          value: 'concise',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await call(state.app, `/api/agent/approvals/${request!.id}`, 'POST', {
          decision: 'reject',
        })
      ).status,
    ).toBe(200)
    expect(
      (await call(state.app, `/api/agent/grants/${grant!.id}/revoke`, 'POST'))
        .status,
    ).toBe(200)
    expect(
      (await call(state.app, `/api/agent/memory/${memory.id}`, 'DELETE'))
        .status,
    ).toBe(200)

    expect(await state.ctx.db.select().from(agentMemory).all()).toHaveLength(0)
    expect(
      await state.ctx.db
        .select()
        .from(agentRequests)
        .where(eq(agentRequests.id, request!.id))
        .get(),
    ).toMatchObject({ status: 'rejected' })
    expect(
      await state.ctx.db
        .select()
        .from(agentToolGrants)
        .where(eq(agentToolGrants.id, grant!.id))
        .get(),
    ).toMatchObject({ status: 'revoked' })
  })
})
