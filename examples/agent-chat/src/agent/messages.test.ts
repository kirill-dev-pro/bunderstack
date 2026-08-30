import { afterEach, describe, expect, test } from 'bun:test'

import { agentMessages, agentRuns } from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { acceptUserMessage, ActiveUserMessageRunError } from './messages'

describe('durable user message acceptance', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function setup() {
    const app = await createTestApp()
    apps.push(app)
    return { ...app, userId: await app.seedUser('Message Badger') }
  }

  test('accepts one message with a queued run and reserved assistant draft', async () => {
    const app = await setup()
    const accepted = await acceptUserMessage(app.ctx, {
      userId: app.userId,
      content: 'List tasks',
      clientMessageId: 'browser-1',
    })

    expect(await app.ctx.db.select().from(agentMessages).all()).toMatchObject([
      { id: accepted.messageId, role: 'user', status: 'complete' },
      {
        id: accepted.assistantMessageId,
        role: 'assistant',
        runId: accepted.runId,
        content: '',
        status: 'queued',
        revision: 0,
      },
    ])
    expect(await app.ctx.db.select().from(agentRuns).get()).toMatchObject({
      id: accepted.runId,
      inputMessageId: accepted.messageId,
      assistantMessageId: accepted.assistantMessageId,
      triggerType: 'user_message',
      status: 'queued',
    })
    expect(app.enqueued.at(-1)).toMatchObject({
      name: 'agentTurn',
      input: {
        threadId: accepted.threadId,
        runId: accepted.runId,
        executionKey: accepted.runId,
      },
      options: { dedupeKey: `agent-run:${accepted.runId}` },
    })
  })

  test('reuses the same accepted run for a repeated client message id', async () => {
    const app = await setup()
    const input = {
      userId: app.userId,
      content: 'List tasks',
      clientMessageId: 'browser-1',
    }
    const first = await acceptUserMessage(app.ctx, input)
    const second = await acceptUserMessage(app.ctx, input)

    expect(second).toEqual(first)
    expect(await app.ctx.db.select().from(agentMessages).all()).toHaveLength(2)
    expect(await app.ctx.db.select().from(agentRuns).all()).toHaveLength(1)
    expect(app.enqueued).toHaveLength(2)
  })

  test('accepts only one of two different messages racing for the active slot', async () => {
    const app = await setup()
    const results = await Promise.allSettled([
      acceptUserMessage(app.ctx, {
        userId: app.userId,
        content: 'First',
        clientMessageId: 'browser-1',
      }),
      acceptUserMessage(app.ctx, {
        userId: app.userId,
        content: 'Second',
        clientMessageId: 'browser-2',
      }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ActiveUserMessageRunError,
    )
    expect(await app.ctx.db.select().from(agentMessages).all()).toHaveLength(2)
    expect(await app.ctx.db.select().from(agentRuns).all()).toHaveLength(1)
  })
})
