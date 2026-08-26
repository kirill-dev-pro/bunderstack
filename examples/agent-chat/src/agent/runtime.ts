import { and, eq, sql } from 'drizzle-orm'

import type { AgentResponder, AgentTask, AgentTools } from './types'
import type { AgentCheckpoint } from './types'

import {
  agentCommitments,
  agentMessages,
  agentRequests,
  agentRuns,
  agentThreads,
} from '../schema'
import {
  agentToolApprovalRequired,
  approvedToolCapability,
  getAgentTool,
  invokeAgentTool,
} from './approvals'
import { assembleAgentContext } from './context'
import { acknowledgeInbox, sendAgentEvent } from './inbox'

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
  input: {
    threadId: string
    reason: string
    runId?: string
    requestId?: string
  },
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
  const [run] = input.runId
    ? await ctx.db
        .update(agentRuns)
        .set({ status: 'running', error: null })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.threadId, thread.id),
            eq(agentRuns.status, 'waiting_for_approval'),
          ),
        )
        .returning()
    : await ctx.db
        .insert(agentRuns)
        .values({
          threadId: thread.id,
          userId: thread.userId,
          reason: input.reason,
          status: 'running',
        })
        .returning()
  if (!run) {
    const [released] = await ctx.db
      .update(agentThreads)
      .set({ status: 'idle', lockedAt: null })
      .where(eq(agentThreads.id, thread.id))
      .returning()
    await ctx.realtime.publish(agentThreads, 'update', released)
    return { status: 'stale' as const }
  }
  await ctx.realtime.publish(agentRuns, input.runId ? 'update' : 'create', run)

  try {
    const resumeRequest = input.requestId
      ? await ctx.db
          .select()
          .from(agentRequests)
          .where(
            and(
              eq(agentRequests.id, input.requestId),
              eq(agentRequests.runId, run.id),
              eq(agentRequests.userId, thread.userId),
            ),
          )
          .get()
      : undefined
    if (
      input.requestId &&
      (!resumeRequest ||
        (resumeRequest.status !== 'approved' &&
          resumeRequest.status !== 'rejected'))
    ) {
      throw new Error('Resolved approval request not found')
    }
    if (
      resumeRequest &&
      (!resumeRequest.approvalId || !resumeRequest.tool || !resumeRequest.args)
    ) {
      throw new Error('Resolved approval request is incomplete')
    }
    const capabilities =
      resumeRequest?.status === 'approved'
        ? [approvedToolCapability(resumeRequest.tool!, resumeRequest.args)]
        : []
    const context = await assembleAgentContext(ctx, {
      thread,
      reason: input.reason,
      now: new Date(),
    })
    const invoke = async (toolId: string, rawArgs: unknown) => {
      const result = await invokeAgentTool(ctx, {
        toolId,
        rawArgs,
        userId: thread.userId,
        threadId: thread.id,
        runId: run.id,
        trigger: {
          type: input.reason.startsWith('message') ? 'user' : 'system',
          trusted: true,
        },
        capabilities,
      })
      if (
        result.status === 'done' &&
        resumeRequest?.status === 'approved' &&
        resumeRequest.tool === toolId
      ) {
        const [resolved] = await ctx.db
          .update(agentRequests)
          .set({ result: result.result })
          .where(eq(agentRequests.id, resumeRequest.id))
          .returning()
        await ctx.realtime.publish(agentRequests, 'update', resolved)
      }
      return result
    }
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
      createCommitment: (args) =>
        requireDone<unknown>('createCommitment', args),
      listCommitments: (args = {}) =>
        requireDone<unknown[]>('listCommitments', args),
      cancelCommitment: (args) =>
        requireDone<unknown>('cancelCommitment', args),
      retryCommitment: (args) => requireDone<unknown>('retryCommitment', args),
      remember: (args) =>
        requireDone<{ key: string; value: unknown }>('remember', args),
      deleteTask: async (args) => {
        const result = await invoke('deleteTask', args)
        return result.status === 'done' ? (result.result as AgentTask) : result
      },
    }

    const response = await responder({
      ...context,
      currentExecution: {
        trigger: input.reason.startsWith('message')
          ? 'user_message'
          : 'system_event',
        runId: run.id,
        objective: context.latestMessage,
      },
      checkpoint: (run.checkpoint as AgentCheckpoint | null) ?? undefined,
      approvalResponse: resumeRequest
        ? {
            approvalId: resumeRequest.approvalId!,
            approved: resumeRequest.status === 'approved',
            reason:
              resumeRequest.status === 'rejected'
                ? 'The user rejected this action.'
                : undefined,
          }
        : undefined,
      toolApprovalRequired: (toolId, rawArgs) =>
        agentToolApprovalRequired(ctx, {
          toolId,
          rawArgs,
          userId: thread.userId,
          threadId: thread.id,
          capabilities,
        }),
      tools,
    })
    if (response.status === 'waiting_for_approval') {
      const definition = getAgentTool(response.request.tool)
      const [request] = await ctx.db
        .insert(agentRequests)
        .values({
          threadId: thread.id,
          userId: thread.userId,
          runId: run.id,
          kind: 'approval',
          prompt: `Allow ${definition.id} with these exact arguments?`,
          tool: definition.id,
          toolVersion: definition.version,
          args: definition.inputSchema.parse(response.request.args),
          approvalId: response.request.approvalId,
          toolCallId: response.request.toolCallId,
        })
        .returning()
      await ctx.realtime.publish(agentRequests, 'create', request)
      const [waitingRun] = await ctx.db
        .update(agentRuns)
        .set({
          status: 'waiting_for_approval',
          checkpoint: response.checkpoint,
        })
        .where(eq(agentRuns.id, run.id))
        .returning()
      await ctx.realtime.publish(agentRuns, 'update', waitingRun)
      return {
        status: 'waiting_for_approval' as const,
        runId: run.id,
        requestId: request!.id,
      }
    }
    if (response.status === 'blocked' || response.status === 'failed') {
      throw new Error(
        response.status === 'blocked' ? response.reason : response.error,
      )
    }
    if (response.text.trim()) {
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
    }
    await acknowledgeInbox(ctx, {
      threadId: thread.id,
      userId: thread.userId,
      ids: context.selectedInboxIds,
    })

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
  await sendAgentEvent(ctx, {
    threadId: commitment.threadId,
    userId: commitment.userId,
    type: 'task.reminder_due',
    payload: { commitmentId: commitment.id, title: commitment.title },
    dedupeKey: `commitment:${commitment.id}`,
  })
  return true
}
