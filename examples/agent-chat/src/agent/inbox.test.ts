import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { agentInbox } from '../schema'
import { createTestApp, type TestApp } from '../test-app'
import { acknowledgeInbox, selectInboxContext, sendAgentEvent } from './inbox'
import { getOrCreateThread } from './runtime'

describe('agent inbox', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function setup() {
    const app = await createTestApp()
    apps.push(app)
    const userId = await app.seedUser('Anonymous Owl')
    const thread = await getOrCreateThread(app.ctx.db, userId)
    return { ...app, userId, thread }
  }

  test('delivery policy controls waking while silent events stay out of context', async () => {
    const state = await setup()
    await sendAgentEvent(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      type: 'task.reminder_due',
      payload: { title: 'Check the oven' },
    })
    await sendAgentEvent(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      type: 'subscription.limit_near',
      payload: { remaining: 2 },
    })
    await sendAgentEvent(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      type: 'audit.silent',
      payload: { code: 'background_refresh' },
    })

    expect(state.enqueued).toHaveLength(1)
    expect(state.enqueued[0]).toMatchObject({
      name: 'agentTurn',
      input: { reason: 'event:task.reminder_due' },
    })
    const selected = await selectInboxContext(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      limit: 10,
      now: new Date(),
    })
    expect(selected.items.map((item) => item.type).sort()).toEqual([
      'subscription.limit_near',
      'task.reminder_due',
    ])
  })

  test('dedupe keeps one pending event and expiry excludes stale rows', async () => {
    const state = await setup()
    const event = {
      threadId: state.thread.id,
      userId: state.userId,
      type: 'subscription.limit_near' as const,
      payload: { remaining: 2 },
      dedupeKey: 'billing-period-2026-08',
    }
    const first = await sendAgentEvent(state.ctx, event)
    const duplicate = await sendAgentEvent(state.ctx, event)
    await sendAgentEvent(state.ctx, {
      ...event,
      dedupeKey: 'expired',
      expiresAt: new Date('2026-08-25T00:00:00.000Z'),
    })

    expect(duplicate.id).toBe(first.id)
    const selected = await selectInboxContext(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      limit: 10,
      now: new Date('2026-08-26T00:00:00.000Z'),
    })
    expect(selected.items).toHaveLength(1)
    expect(
      await state.ctx.db
        .select()
        .from(agentInbox)
        .where(eq(agentInbox.dedupeKey, 'expired'))
        .get(),
    ).toMatchObject({ status: 'expired' })
  })

  test('latest, collect, and count aggregate into bounded literal items', async () => {
    const state = await setup()
    for (const remaining of [5, 3, 1]) {
      await sendAgentEvent(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
        type: 'subscription.limit_near',
        payload: { remaining },
      })
    }
    for (const title of ['A', 'B']) {
      await sendAgentEvent(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
        type: 'activity.digest',
        payload: { title },
      })
    }
    for (let index = 0; index < 4; index++) {
      await sendAgentEvent(state.ctx, {
        threadId: state.thread.id,
        userId: state.userId,
        type: 'notification.count',
        payload: { index },
      })
    }

    const selected = await selectInboxContext(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      limit: 3,
      now: new Date(),
    })
    expect(selected.items).toHaveLength(3)
    expect(
      selected.items.find((item) => item.type === 'subscription.limit_near'),
    ).toMatchObject({ payload: { remaining: 1 }, aggregate: 'latest' })
    expect(
      selected.items.find((item) => item.type === 'activity.digest'),
    ).toMatchObject({
      payload: [{ title: 'A' }, { title: 'B' }],
      aggregate: 'collect',
    })
    expect(
      selected.items.find((item) => item.type === 'notification.count'),
    ).toMatchObject({ payload: { count: 4 }, aggregate: 'count' })

    await acknowledgeInbox(state.ctx, {
      threadId: state.thread.id,
      userId: state.userId,
      ids: selected.selectedIds,
    })
    expect(
      await state.ctx.db
        .select()
        .from(agentInbox)
        .where(eq(agentInbox.status, 'pending'))
        .all(),
    ).toHaveLength(0)
  })
})
