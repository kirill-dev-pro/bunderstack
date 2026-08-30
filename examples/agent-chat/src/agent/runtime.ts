import { generateTypeId } from 'bunderstack'
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm'

import {
  type AgentCheckpoint,
  type AgentResponder,
  type AgentTask,
  type AgentTools,
} from './types'

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
import { createRunRecorder, type RunRecorder } from './run-recorder'

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

  try {
    const [created] = await db
      .insert(agentThreads)
      .values({ userId })
      .returning()
    return created!
  } catch (error) {
    const raced = await db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.userId, userId))
      .get()
    if (raced) return raced
    throw error
  }
}

async function enqueueTurn(
  ctx: AgentRuntimeContext,
  threadId: string,
  reason: string,
  dedupeKey = `agent-turn:${threadId}`,
  executionKey = generateTypeId('arun'),
) {
  await ctx.jobs.enqueue(
    'agentTurn',
    { threadId, reason, executionKey },
    { dedupeKey },
  )
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

export async function acquireAgentThreadLock(
  ctx: AgentRuntimeContext,
  threadId: string,
) {
  const staleBefore = new Date(Date.now() - 10 * 60_000)
  const [thread] = await ctx.db
    .update(agentThreads)
    .set({ status: 'running', lockedAt: new Date() })
    .where(
      and(
        eq(agentThreads.id, threadId),
        or(
          eq(agentThreads.status, 'idle'),
          lt(agentThreads.lockedAt, staleBefore),
        ),
      ),
    )
    .returning()
  return thread
}

export async function releaseAgentThreadLock(
  ctx: AgentRuntimeContext,
  thread: typeof agentThreads.$inferSelect,
  lockedWakeSeq: number,
) {
  const [released] = await ctx.db
    .update(agentThreads)
    .set({ status: 'idle', lockedAt: null })
    .where(eq(agentThreads.id, thread.id))
    .returning()
  await ctx.realtime.publish(agentThreads, 'update', released)
  if (released.wakeSeq !== lockedWakeSeq) {
    await enqueueTurn(
      ctx,
      thread.id,
      'wake.during_turn',
      `agent-turn:${thread.id}:wake:${released.wakeSeq}`,
    )
  }
}

export async function runAgentTurn(
  ctx: AgentRuntimeContext,
  input: {
    threadId: string
    reason: string
    runId?: string
    requestId?: string
    executionKey?: string
  },
  responder: AgentResponder,
) {
  const thread = await acquireAgentThreadLock(ctx, input.threadId)
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
            inArray(agentRuns.status, ['queued', 'waiting_for_approval']),
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

  let currentRun = run
  let recorder: RunRecorder | undefined
  const getRecorder = async () => {
    if (recorder) return recorder
    if (!currentRun.assistantMessageId) {
      const draftId = generateTypeId('amsg')
      const created = await ctx.db.transaction(async (tx: any) => {
        const [draft] = await tx
          .insert(agentMessages)
          .values({
            id: draftId,
            threadId: thread.id,
            userId: thread.userId,
            runId: currentRun.id,
            role: 'assistant',
            content: '',
            status: 'queued',
          })
          .returning()
        const [updatedRun] = await tx
          .update(agentRuns)
          .set({ assistantMessageId: draftId })
          .where(eq(agentRuns.id, currentRun.id))
          .returning()
        return { draft: draft!, run: updatedRun! }
      })
      currentRun = created.run
      await ctx.realtime.publish(agentMessages, 'create', created.draft)
      await ctx.realtime.publish(agentRuns, 'update', currentRun)
    }
    recorder = await createRunRecorder(ctx, currentRun)
    return recorder
  }

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
      (!resumeRequest.approvalId ||
        !resumeRequest.tool ||
        !resumeRequest.toolVersion ||
        !resumeRequest.toolCallId ||
        !resumeRequest.args)
    ) {
      throw new Error('Resolved approval request is incomplete')
    }
    const capabilities =
      resumeRequest?.status === 'approved'
        ? [
            approvedToolCapability({
              toolId: resumeRequest.tool!,
              toolVersion: resumeRequest.toolVersion!,
              toolCallId: resumeRequest.toolCallId!,
              args: resumeRequest.args,
            }),
          ]
        : []
    const context = await assembleAgentContext(ctx, {
      thread,
      reason: input.reason,
      now: new Date(),
      excludeMessageId: currentRun.assistantMessageId ?? undefined,
    })
    let invocationSequence =
      (run.checkpoint as AgentCheckpoint | null)?.toolSequence ?? 0
    const executionKey =
      (run.checkpoint as AgentCheckpoint | null)?.executionKey ??
      input.executionKey ??
      run.id
    const invoke = async (toolId: string, rawArgs: unknown) => {
      invocationSequence += 1
      const definition = getAgentTool(toolId)
      const activeRecorder = await getRecorder()
      const step = await activeRecorder.startStep({
        kind: 'tool_call',
        title: `${definition.id} v${definition.version}`,
        input: rawArgs,
        visibility: 'visible',
      })
      let result: Awaited<ReturnType<typeof invokeAgentTool>>
      try {
        result = await invokeAgentTool(ctx, {
          toolId,
          rawArgs,
          userId: thread.userId,
          threadId: thread.id,
          runId: currentRun.id,
          trigger: {
            type: input.reason.startsWith('message') ? 'user' : 'system',
            trusted: true,
          },
          capabilities,
          executionId: `${executionKey}:tool:${invocationSequence}`,
        })
      } catch (error) {
        await activeRecorder.failStep(step.id, error)
        throw error
      }
      if (result.status === 'done') {
        await activeRecorder.finishStep(step.id, result.result, {
          toolCallId: result.toolCallId,
        })
      } else {
        await activeRecorder.finishStep(step.id, {
          approvalRequired: true,
        })
      }
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
      pauseCommitment: (args) => requireDone<unknown>('pauseCommitment', args),
      resumeCommitment: (args) =>
        requireDone<unknown>('resumeCommitment', args),
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
      stream: {
        signal: new AbortController().signal,
        writeTextDelta: async (delta) => {
          await (await getRecorder()).appendText(delta)
        },
        writeStatus: async (title) => {
          const activeRecorder = await getRecorder()
          const step = await activeRecorder.startStep({
            kind: 'status',
            title,
            visibility: 'visible',
          })
          await activeRecorder.finishStep(step.id)
        },
      },
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
      if (recorder) await recorder.flush()
      const definition = getAgentTool(response.request.tool)
      const [request] = await ctx.db
        .insert(agentRequests)
        .values({
          threadId: thread.id,
          userId: thread.userId,
          runId: currentRun.id,
          kind: 'approval',
          prompt: `Allow ${definition.id} with these exact arguments?`,
          tool: definition.id,
          toolVersion: definition.version,
          args: definition.inputSchema.parse(response.request.args),
          approvalId: response.request.approvalId,
          toolCallId: response.request.toolCallId,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        })
        .returning()
      await ctx.realtime.publish(agentRequests, 'create', request)
      const [waitingRun] = await ctx.db
        .update(agentRuns)
        .set({
          status: 'waiting_for_approval',
          checkpoint: {
            ...response.checkpoint,
            toolSequence: invocationSequence,
            executionKey,
          },
        })
        .where(eq(agentRuns.id, currentRun.id))
        .returning()
      await ctx.realtime.publish(agentRuns, 'update', waitingRun)
      return {
        status: 'waiting_for_approval' as const,
        runId: currentRun.id,
        requestId: request!.id,
      }
    }
    if (response.status === 'blocked' || response.status === 'failed') {
      throw new Error(
        response.status === 'blocked' ? response.reason : response.error,
      )
    }
    if (response.text.trim() || currentRun.assistantMessageId || recorder) {
      const activeRecorder = await getRecorder()
      await activeRecorder.replaceText(response.text)
      await activeRecorder.finishMessage('complete')
    }
    await acknowledgeInbox(ctx, {
      threadId: thread.id,
      userId: thread.userId,
      ids: context.selectedInboxIds,
    })

    const [finished] = await ctx.db
      .update(agentRuns)
      .set({ status: 'complete', completedAt: new Date() })
      .where(eq(agentRuns.id, currentRun.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', finished)
    return { status: 'complete' as const }
  } catch (error) {
    console.error('Error during agent turn:', error)
    const message = error instanceof Error ? error.message : String(error)
    if (currentRun.assistantMessageId || recorder) {
      try {
        const activeRecorder = await getRecorder()
        await activeRecorder.flush()
        const [failedMessage] = await ctx.db
          .update(agentMessages)
          .set({
            status: 'error',
            revision: sql`${agentMessages.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(agentMessages.id, currentRun.assistantMessageId!))
          .returning()
        if (failedMessage) {
          await ctx.realtime.publish(agentMessages, 'update', failedMessage)
        }
      } catch (snapshotError) {
        console.error('Failed to persist the final agent snapshot:', snapshotError)
      }
    }
    const [failed] = await ctx.db
      .update(agentRuns)
      .set({ status: 'error', error: message, completedAt: new Date() })
      .where(eq(agentRuns.id, currentRun.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', failed)
    throw error
  } finally {
    await releaseAgentThreadLock(ctx, thread, lockedWakeSeq)
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
