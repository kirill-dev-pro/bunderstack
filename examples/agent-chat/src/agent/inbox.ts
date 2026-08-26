import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
} from 'drizzle-orm'

import { agentInbox } from '../schema'
import { agentDefinition } from './definition'
import { wakeAgent, type AgentRuntimeContext } from './runtime'

type AgentEventType = keyof typeof agentDefinition.events

export interface InboxContextItem {
  type: string
  delivery: 'immediate' | 'next_turn'
  aggregate: 'latest' | 'collect' | 'count'
  payload: Record<string, unknown> | Record<string, unknown>[] | { count: number }
}

export async function sendAgentEvent(
  ctx: AgentRuntimeContext,
  input: {
    threadId: string
    userId: string
    type: AgentEventType
    payload: Record<string, unknown>
    dedupeKey?: string
    expiresAt?: Date
  },
) {
  const policy = agentDefinition.events[input.type]
  if (!policy) throw new Error(`Unknown agent event: ${String(input.type)}`)

  const [inserted] = await ctx.db
    .insert(agentInbox)
    .values({
      threadId: input.threadId,
      userId: input.userId,
      type: input.type,
      payload: input.payload,
      delivery: policy.delivery,
      aggregate: policy.aggregate,
      dedupeKey: input.dedupeKey,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning()
  const row =
    inserted ??
    (await ctx.db
      .select()
      .from(agentInbox)
      .where(
        and(
          eq(agentInbox.threadId, input.threadId),
          eq(agentInbox.userId, input.userId),
          eq(agentInbox.dedupeKey, input.dedupeKey!),
          eq(agentInbox.status, 'pending'),
        ),
      )
      .get())
  if (!row) throw new Error('Could not store agent event')

  if (inserted) {
    await ctx.realtime.publish(agentInbox, 'create', inserted)
    if (policy.delivery === 'immediate') {
      await wakeAgent(ctx, input.threadId, `event:${String(input.type)}`)
    }
  }
  return row
}

export async function selectInboxContext(
  ctx: AgentRuntimeContext,
  input: {
    threadId: string
    userId: string
    limit: number
    now: Date
  },
): Promise<{ items: InboxContextItem[]; selectedIds: string[] }> {
  await ctx.db
    .update(agentInbox)
    .set({ status: 'expired' })
    .where(
      and(
        eq(agentInbox.threadId, input.threadId),
        eq(agentInbox.userId, input.userId),
        eq(agentInbox.status, 'pending'),
        lt(agentInbox.expiresAt, input.now),
      ),
    )

  const rows = (await ctx.db
    .select()
    .from(agentInbox)
    .where(
      and(
        eq(agentInbox.threadId, input.threadId),
        eq(agentInbox.userId, input.userId),
        eq(agentInbox.status, 'pending'),
        ne(agentInbox.delivery, 'silent'),
        or(isNull(agentInbox.expiresAt), gt(agentInbox.expiresAt, input.now)),
      ),
    )
    .orderBy(asc(agentInbox.createdAt), asc(agentInbox.id))
    .all()) as Array<typeof agentInbox.$inferSelect>

  const grouped = new Map<string, Array<typeof agentInbox.$inferSelect>>()
  for (const row of rows) {
    const current = grouped.get(row.type) ?? []
    current.push(row)
    grouped.set(row.type, current)
  }

  const groups = [...grouped.values()].slice(-Math.max(0, input.limit))
  const selectedIds = groups.flatMap((group) => group.map((row) => row.id))
  const items = groups.map((group): InboxContextItem => {
    const last = group.at(-1)!
    const payload =
      last.aggregate === 'latest'
        ? last.payload
        : last.aggregate === 'count'
          ? { count: group.length }
          : group.map((row) => row.payload)
    return {
      type: last.type,
      delivery: last.delivery as 'immediate' | 'next_turn',
      aggregate: last.aggregate,
      payload,
    }
  })
  return { items, selectedIds }
}

export async function acknowledgeInbox(
  ctx: AgentRuntimeContext,
  input: { threadId: string; userId: string; ids: string[] },
): Promise<number> {
  if (input.ids.length === 0) return 0
  const rows = await ctx.db
    .update(agentInbox)
    .set({ status: 'consumed', consumedAt: new Date() })
    .where(
      and(
        eq(agentInbox.threadId, input.threadId),
        eq(agentInbox.userId, input.userId),
        eq(agentInbox.status, 'pending'),
        inArray(agentInbox.id, input.ids),
      ),
    )
    .returning()
  await Promise.all(
    rows.map((row: unknown) =>
      ctx.realtime.publish(agentInbox, 'update', row),
    ),
  )
  return rows.length
}
