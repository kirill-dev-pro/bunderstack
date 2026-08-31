import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { mergeRevisionedMessage } from '../components/streaming-text'
import { agentMessages, agentRunSteps } from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { acceptUserMessage } from './messages'
import { getOrCreateThread, runAgentTurn } from './runtime'

describe('durable streaming recovery', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function setup() {
    const app = await createTestApp()
    apps.push(app)
    const userId = await app.seedUser('Recovery Reader')
    const thread = await getOrCreateThread(app.ctx.db, userId)
    return { ...app, userId, thread }
  }

  test('a fresh reader reconstructs the latest draft while its job is still active', async () => {
    const state = await setup()
    const accepted = await acceptUserMessage(state.ctx, {
      userId: state.userId,
      content: 'Explain the tasks',
      clientMessageId: 'browser-recovery-1',
    })
    const firstDeltaPersisted = Promise.withResolvers<void>()
    const releaseResponder = Promise.withResolvers<void>()

    const running = runAgentTurn(
      state.ctx,
      {
        threadId: state.thread.id,
        reason: 'message',
        runId: accepted.runId,
        executionKey: accepted.runId,
      },
      async (input) => {
        await input.stream.writeStatus('Inspecting tasks')
        await input.stream.writeTextDelta('Current answer')
        firstDeltaPersisted.resolve()
        await releaseResponder.promise
        await input.stream.writeTextDelta(' completed')
        return {
          status: 'completed' as const,
          text: 'Current answer completed',
          checkpoint: { messages: [] },
        }
      },
    )

    try {
      await firstDeltaPersisted.promise

      const freshDraft = await state.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, accepted.assistantMessageId))
        .get()
      expect(freshDraft).toMatchObject({
        content: 'Current answer',
        status: 'streaming',
      })
      expect(
        await state.ctx.db.select().from(agentRunSteps).all(),
      ).toMatchObject([{ title: 'Inspecting tasks', status: 'complete' }])

      const duplicate = await acceptUserMessage(state.ctx, {
        userId: state.userId,
        content: 'Explain the tasks',
        clientMessageId: 'browser-recovery-1',
      })
      expect(duplicate).toEqual(accepted)

      expect(
        mergeRevisionedMessage(freshDraft!, {
          ...freshDraft!,
          content: 'Stale answer',
          revision: freshDraft!.revision - 1,
        }),
      ).toBe(freshDraft)
    } finally {
      releaseResponder.resolve()
      await running
    }

    expect(
      await state.ctx.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, accepted.assistantMessageId))
        .get(),
    ).toMatchObject({
      content: 'Current answer completed',
      status: 'complete',
    })
  })
})
