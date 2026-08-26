import { and, asc, eq, sql } from 'drizzle-orm'

import type { AgentResponder, AgentTask, AgentTools } from './types'
import { invokeAgentTool } from './approvals'

import {
  agentCommitments,
  agentMessages,
  agentRuns,
  agentThreads,
  tasks,
} from '../schema'

export interface EnqueuedJob {
  name: string
  input: Record<string, unknown>
  options: { dedupeKey?: string; runAt?: Date }
}

export interface AgentRuntimeContext {
  db: any
  jobs: {
    enqueue(
      name: string,
      input: Record<string, unknown>,
      options?: { dedupeKey?: string; runAt?: Date },
    ): Promise<unknown>
  }
  realtime: {
    publish(
      table: unknown,
      action: 'create' | 'update' | 'delete',
      row: unknown,
    ): Promise<unknown>
  }
}

export async function getOrCreateThread(db: any, userId: any) {
  const existing = await db
    .select()
    .from(agentThreads)
    .where(eq(agentThreads.userId, userId))
    .get()
  if (existing) return existing

  const [created] = await db.insert(agentThreads).values({ userId }).returning()
  return created!
}

async function enqueueTurn(
  ctx: AgentRuntimeContext,
  threadId: string,
  reason: string,
  dedupeKey = `agent-turn:${threadId}`,
) {
  await ctx.jobs.enqueue('agentTurn', { threadId, reason }, { dedupeKey })
}

export async function wakeAgent(
  ctx: AgentRuntimeContext,
  threadId: string,
  reason: string,
) {
  await ctx.db
    .update(agentThreads)
    .set({ wakeSeq: sql`${agentThreads.wakeSeq} + 1` })
    .where(eq(agentThreads.id, threadId))
  await enqueueTurn(ctx, threadId, reason)
}

export async function runAgentTurn(
  ctx: AgentRuntimeContext,
  input: { threadId: string; reason: string },
  responder: AgentResponder,
) {
  const staleBefore = new Date(Date.now() - 10 * 60_000)
  const [thread] = await ctx.db
    .update(agentThreads)
    .set({ status: 'running', lockedAt: new Date() })
    .where(
      and(
        eq(agentThreads.id, input.threadId),
        sql`(${agentThreads.status} = 'idle' or ${agentThreads.lockedAt} < ${staleBefore})`,
      ),
    )
    .returning()
  if (!thread) return { status: 'busy' as const }

  const lockedWakeSeq = thread.wakeSeq
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      threadId: thread.id,
      userId: thread.userId,
      reason: input.reason,
      status: 'running',
    })
    .returning()
  await ctx.realtime.publish(agentRuns, 'create', run)

  try {
    const messages = await ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, thread.id))
      .orderBy(asc(agentMessages.createdAt))
      .all()
    const currentTasks = (await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, thread.userId))
      .orderBy(asc(tasks.createdAt))
      .all()) as AgentTask[]
    const invoke = (toolId: string, rawArgs: unknown) =>
      invokeAgentTool(ctx, {
        toolId,
        rawArgs,
        userId: thread.userId,
        threadId: thread.id,
        runId: run.id,
        trigger: {
          type: input.reason.startsWith('system.') ? 'system' : 'user',
          trusted: true,
        },
      })
    const requireDone = async <T>(toolId: string, rawArgs: unknown) => {
      const result = await invoke(toolId, rawArgs)
      if (result.status !== 'done') {
        throw new Error(`${toolId} unexpectedly requires approval`)
      }
      return result.result as T
    }

    const tools: AgentTools = {
      listTasks: () => requireDone<AgentTask[]>('listTasks', {}),
      createTask: (args) => requireDone<AgentTask>('createTask', args),
      completeTask: (args) => requireDone<AgentTask>('completeTask', args),
      scheduleReminder: (args) =>
        requireDone<{ id: string; title: string; dueAt: Date }>(
          'scheduleReminder',
          args,
        ),
      deleteTask: async (args) => {
        const result = await invoke('deleteTask', args)
        return result.status === 'done' ? (result.result as AgentTask) : result
      },
    }

    const response = await responder({
      reason: input.reason,
      now: new Date(),
      latestMessage: messages.at(-1)?.content ?? '',
      messages: messages.map((message: any) => ({
        role: message.role,
        content: message.content,
      })),
      tasks: currentTasks,
      tools,
    })
    const [assistantMessage] = await ctx.db
      .insert(agentMessages)
      .values({
        threadId: thread.id,
        userId: thread.userId,
        role: 'assistant',
        content: response.text,
      })
      .returning()
    await ctx.realtime.publish(agentMessages, 'create', assistantMessage)

    const [finished] = await ctx.db
      .update(agentRuns)
      .set({ status: 'done', completedAt: new Date() })
      .where(eq(agentRuns.id, run.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', finished)
    return { status: 'done' as const }
  } catch (error) {
    console.error('Error during agent turn:', error)
    const message = error instanceof Error ? error.message : String(error)
    const [failed] = await ctx.db
      .update(agentRuns)
      .set({ status: 'failed', error: message, completedAt: new Date() })
      .where(eq(agentRuns.id, run.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', failed)
    throw error
  } finally {
    const [released] = await ctx.db
      .update(agentThreads)
      .set({ status: 'idle', lockedAt: null })
      .where(eq(agentThreads.id, thread.id))
      .returning()
    await ctx.realtime.publish(agentThreads, 'update', released)
    if (released.wakeSeq !== lockedWakeSeq) {
      // The normal stable key still belongs to the currently running job until
      // its handler returns. A sequence-specific recovery key therefore makes
      // the post-turn enqueue a distinct durable row instead of a dedupe no-op.
      await enqueueTurn(
        ctx,
        thread.id,
        'wake.during_turn',
        `agent-turn:${thread.id}:wake:${released.wakeSeq}`,
      )
    }
  }
}

export async function fireCommitment(
  ctx: AgentRuntimeContext,
  commitmentId: string,
): Promise<boolean> {
  const [commitment] = await ctx.db
    .update(agentCommitments)
    .set({ status: 'fired', firedAt: new Date() })
    .where(
      and(
        eq(agentCommitments.id, commitmentId),
        eq(agentCommitments.status, 'pending'),
      ),
    )
    .returning()
  if (!commitment) return false

  await ctx.realtime.publish(agentCommitments, 'update', commitment)
  const [message] = await ctx.db
    .insert(agentMessages)
    .values({
      threadId: commitment.threadId,
      userId: commitment.userId,
      role: 'system',
      content: `Reminder due: ${commitment.title}`,
    })
    .returning()
  await ctx.realtime.publish(agentMessages, 'create', message)
  await wakeAgent(ctx, commitment.threadId, 'commitment.fired')
  return true
}
