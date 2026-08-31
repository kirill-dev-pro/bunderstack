import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { agentMessages, agentRuns } from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import {
  AgentRunCancelledError,
  requestRunCancellation,
} from './cancellation'
import { acceptUserMessage } from './messages'
import { createRunRecorder } from './run-recorder'

describe('durable run cancellation', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function setupRunningRun(content = 'Partial answer') {
    const app = await createTestApp()
    apps.push(app)
    const userId = await app.seedUser('Stopping Mink')
    const accepted = await acceptUserMessage(app.ctx, {
      userId,
      content: 'Explain tasks',
      clientMessageId: 'browser-stop-1',
    })
    const [run] = await app.ctx.db
      .update(agentRuns)
      .set({ status: 'running' })
      .where(eq(agentRuns.id, accepted.runId))
      .returning()
    await app.ctx.db
      .update(agentMessages)
      .set({ content, status: 'streaming', revision: 1 })
      .where(eq(agentMessages.id, accepted.assistantMessageId))
    const recorder = await createRunRecorder(app.ctx, run!)
    return { app, userId, accepted, run: run!, recorder }
  }

  test('the owner requests cancellation without deleting partial text', async () => {
    const state = await setupRunningRun()
    const result = await requestRunCancellation(state.app.ctx, {
      runId: state.run.id,
      userId: state.userId,
    })

    expect(result?.status).toBe('cancelling')
    expect(
      await state.app.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, state.accepted.assistantMessageId))
        .get(),
    ).toMatchObject({ content: 'Partial answer', status: 'streaming' })
  })

  test('a recorder observation reports the durable cancellation request', async () => {
    const state = await setupRunningRun()
    await requestRunCancellation(state.app.ctx, {
      runId: state.run.id,
      userId: state.userId,
    })

    await expect(state.recorder.checkCancellation()).rejects.toBeInstanceOf(
      AgentRunCancelledError,
    )
  })

  test('a queued run cancels immediately and keeps its reserved draft', async () => {
    const app = await createTestApp()
    apps.push(app)
    const userId = await app.seedUser('Queued Ferret')
    const accepted = await acceptUserMessage(app.ctx, {
      userId,
      content: 'Wait here',
      clientMessageId: 'browser-stop-queued',
    })

    const result = await requestRunCancellation(app.ctx, {
      runId: accepted.runId,
      userId,
    })

    expect(result?.status).toBe('cancelled')
    expect(
      await app.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, accepted.assistantMessageId))
        .get(),
    ).toMatchObject({ content: '', status: 'cancelled' })
  })
})
