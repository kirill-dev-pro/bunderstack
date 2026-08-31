import { and, eq, inArray, sql } from 'drizzle-orm'

import { agentMessages, agentRequests, agentRuns } from '../schema'
import type { AgentRuntimeContext } from './runtime'

export class AgentRunCancelledError extends Error {
  constructor() {
    super('Agent run cancelled')
    this.name = 'AgentRunCancelledError'
  }
}

export async function requestRunCancellation(
  ctx: AgentRuntimeContext,
  input: { runId: string; userId: string },
) {
  const run = await ctx.db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, input.userId)),
    )
    .get()
  if (!run) return undefined

  if (run.status === 'queued' || run.status === 'waiting_for_approval') {
    const cancelled = await ctx.db.transaction(async (tx: any) => {
      const [cancelledRun] = await tx
        .update(agentRuns)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(
          and(
            eq(agentRuns.id, run.id),
            eq(agentRuns.userId, input.userId),
            inArray(agentRuns.status, ['queued', 'waiting_for_approval']),
          ),
        )
        .returning()
      if (!cancelledRun) return undefined

      const [assistantMessage] = run.assistantMessageId
        ? await tx
            .update(agentMessages)
            .set({
              status: 'cancelled',
              revision: sql`${agentMessages.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(agentMessages.id, run.assistantMessageId))
            .returning()
        : []
      const requests = await tx
        .update(agentRequests)
        .set({ status: 'rejected', resolvedAt: new Date() })
        .where(
          and(
            eq(agentRequests.runId, run.id),
            eq(agentRequests.status, 'pending'),
          ),
        )
        .returning()
      return { run: cancelledRun, assistantMessage, requests }
    })
    if (!cancelled) {
      return ctx.db
        .select()
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, input.userId)),
        )
        .get()
    }
    await ctx.realtime.publish(agentRuns, 'update', cancelled.run)
    if (cancelled.assistantMessage) {
      await ctx.realtime.publish(
        agentMessages,
        'update',
        cancelled.assistantMessage,
      )
    }
    for (const request of cancelled.requests) {
      await ctx.realtime.publish(agentRequests, 'update', request)
    }
    return cancelled.run
  }

  if (run.status === 'running') {
    const [cancelling] = await ctx.db
      .update(agentRuns)
      .set({ status: 'cancelling' })
      .where(
        and(
          eq(agentRuns.id, run.id),
          eq(agentRuns.userId, input.userId),
          eq(agentRuns.status, 'running'),
        ),
      )
      .returning()
    if (cancelling) {
      await ctx.realtime.publish(agentRuns, 'update', cancelling)
      return cancelling
    }
    return ctx.db
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, input.userId)),
      )
      .get()
  }

  return run
}
