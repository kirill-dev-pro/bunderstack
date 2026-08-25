import { and, asc, eq, sql } from 'drizzle-orm'

import type { AgentResponder, AgentTask, AgentTools } from './types'

import {
  agentCommitments,
  agentMessages,
  agentRuns,
  agentThreads,
  agentToolCalls,
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
      action: 'create' | 'update',
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

async function recordTool<T>(
  ctx: AgentRuntimeContext,
  details: { runId: string; threadId: string; userId: string },
  tool: string,
  args: Record<string, unknown>,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    const result = await invoke()
    const [call] = await ctx.db
      .insert(agentToolCalls)
      .values({ ...details, tool, args, result, status: 'done' })
      .returning()
    await ctx.realtime.publish(agentToolCalls, 'create', call)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const [call] = await ctx.db
      .insert(agentToolCalls)
      .values({ ...details, tool, args, status: 'failed', error: message })
      .returning()
    await ctx.realtime.publish(agentToolCalls, 'create', call)
    throw error
  }
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
    const details = {
      runId: run.id,
      threadId: thread.id,
      userId: thread.userId,
    }

    const tools: AgentTools = {
      listTasks: () =>
        recordTool(ctx, details, 'listTasks', {}, async () =>
          ctx.db
            .select()
            .from(tasks)
            .where(eq(tasks.userId, thread.userId))
            .all(),
        ),
      createTask: (args) =>
        recordTool(ctx, details, 'createTask', args, async () => {
          const [task] = await ctx.db
            .insert(tasks)
            .values({ userId: thread.userId, title: args.title })
            .returning()
          await ctx.realtime.publish(tasks, 'create', task)
          return task
        }),
      completeTask: (args) =>
        recordTool(ctx, details, 'completeTask', args, async () => {
          const [task] = await ctx.db
            .update(tasks)
            .set({ done: true, completedAt: new Date() })
            .where(
              and(eq(tasks.id, args.taskId), eq(tasks.userId, thread.userId)),
            )
            .returning()
          if (!task) throw new Error('Task not found')
          await ctx.realtime.publish(tasks, 'update', task)
          return task
        }),
      scheduleReminder: (args) =>
        recordTool(ctx, details, 'scheduleReminder', args, async () => {
          const [commitment] = await ctx.db
            .insert(agentCommitments)
            .values({
              threadId: thread.id,
              userId: thread.userId,
              kind: 'reminder',
              title: args.title,
              dueAt: args.dueAt,
            })
            .returning()
          await ctx.realtime.publish(agentCommitments, 'create', commitment)
          await ctx.jobs.enqueue(
            'agentReminder',
            { commitmentId: commitment.id },
            { runAt: args.dueAt },
          )
          return {
            id: commitment.id,
            title: commitment.title,
            dueAt: commitment.dueAt,
          }
        }),
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
