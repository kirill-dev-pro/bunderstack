import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  agentCommitments,
  agentMessages,
  agentRuns,
  agentThreads,
  agentToolCalls,
  tasks,
} from '../schema'
import { createTestApp, type TestApp } from '../test-app'
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
        return { text: 'Added “Book flights”.' }
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
    expect(runs[0]?.status).toBe('done')

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

  test('a scheduled reminder becomes a future job and a journal entry', async () => {
    const { ctx, enqueued, thread } = await setup()
    const dueAt = new Date('2026-08-25T09:30:00.000Z')

    await runAgentTurn(
      ctx,
      { threadId: thread.id, reason: 'message' },
      async ({ tools }) => {
        await tools.scheduleReminder({ title: 'Check the oven', dueAt })
        return { text: 'I will remind you.' }
      },
    )

    expect(enqueued).toContainEqual({
      name: 'agentReminder',
      input: expect.any(Object),
      options: { runAt: dueAt },
    })
    expect(await ctx.db.select().from(agentCommitments).all()).toHaveLength(1)
    expect((await ctx.db.select().from(agentToolCalls).all())[0]).toMatchObject(
      { tool: 'scheduleReminder', status: 'done' },
    )
  })

  test('firing a commitment is idempotent, inserts a system message, and wakes the same agent', async () => {
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

    const messages = await ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, thread.id))
      .all()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: 'Reminder due: Check the oven',
    })
    expect(enqueued.at(-1)).toMatchObject({
      name: 'agentTurn',
      input: { threadId: thread.id, reason: 'commitment.fired' },
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
      input: { threadId: thread.id, reason: 'message' },
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
        return { text: 'First turn finished.' }
      },
    )

    expect(enqueued.at(-1)).toEqual({
      name: 'agentTurn',
      input: { threadId: thread.id, reason: 'wake.during_turn' },
      options: { dedupeKey: `agent-turn:${thread.id}:wake:1` },
    })
  })
})
