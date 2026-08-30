import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { agentMessages, agentRuns, agentRunSteps } from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { acceptUserMessage } from './messages'
import { createRunRecorder } from './run-recorder'

describe('durable run recorder', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function setupRecorder() {
    const app = await createTestApp()
    apps.push(app)
    const userId = await app.seedUser('Recorder Stoat')
    const accepted = await acceptUserMessage(app.ctx, {
      userId,
      content: 'Explain tasks',
      clientMessageId: 'browser-recorder-1',
    })
    const run = await app.ctx.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, accepted.runId))
      .get()
    const published: Array<{ table: unknown; action: string; row: unknown }> = []
    const ctx = {
      ...app.ctx,
      realtime: {
        async publish(table: unknown, action: string, row: unknown) {
          published.push({ table, action, row })
        },
      },
    }
    return { app, ctx, run: run!, accepted, published }
  }

  async function readMessage(app: TestApp, id: string) {
    return app.ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, id))
      .get()
  }

  test('persists an immediate snapshot, a trailing snapshot, and the final remainder', async () => {
    let now = 1_000
    let scheduled: (() => Promise<void>) | undefined
    const { app, ctx, run, accepted, published } = await setupRecorder()
    const recorder = await createRunRecorder(ctx, run, {
      flushMs: 150,
      now: () => now,
      schedule: (callback) => {
        scheduled = callback
        return 1
      },
      cancelScheduled: () => {
        scheduled = undefined
      },
    })

    await recorder.appendText('Hello')
    now += 50
    await recorder.appendText(' world')
    expect(await readMessage(app, accepted.assistantMessageId)).toMatchObject({
      content: 'Hello',
      revision: 1,
      status: 'streaming',
    })

    now += 100
    await scheduled?.()
    expect(await readMessage(app, accepted.assistantMessageId)).toMatchObject({
      content: 'Hello world',
      revision: 2,
    })

    await recorder.appendText('!')
    await recorder.flush()
    expect(await readMessage(app, accepted.assistantMessageId)).toMatchObject({
      content: 'Hello world!',
      revision: 3,
    })
    expect(
      published.filter((item) => item.table === agentMessages),
    ).toHaveLength(3)
  })

  test('records ordered visible steps and resumes after the largest sequence', async () => {
    const { ctx, run } = await setupRecorder()
    await ctx.db.insert(agentRunSteps).values({
      runId: run.id,
      threadId: run.threadId,
      userId: run.userId,
      sequence: 3,
      kind: 'status',
      title: 'Earlier work',
      status: 'complete',
      visibility: 'visible',
    })
    const recorder = await createRunRecorder(ctx, run)
    const step = await recorder.startStep({
      kind: 'tool_call',
      title: 'listTasks v1',
      input: {},
      visibility: 'visible',
    })
    await recorder.finishStep(step.id, [{ id: 'task_1' }])

    expect(await ctx.db.select().from(agentRunSteps).all()).toMatchObject([
      { sequence: 3, title: 'Earlier work', status: 'complete' },
      {
        sequence: 4,
        kind: 'tool_call',
        status: 'complete',
        input: {},
        output: [{ id: 'task_1' }],
      },
    ])
  })

  test('finishes the reserved message without replacing its accumulated text', async () => {
    const { app, ctx, run, accepted } = await setupRecorder()
    const recorder = await createRunRecorder(ctx, run)
    await recorder.appendText('Final answer')
    await recorder.finishMessage('complete')

    expect(await readMessage(app, accepted.assistantMessageId)).toMatchObject({
      content: 'Final answer',
      status: 'complete',
      revision: 2,
    })
  })
})
