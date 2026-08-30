import { generateTypeId } from 'bunderstack'
import { cronMatches, parseCron } from 'bunderstack/cron'
import { and, asc, eq, inArray, lt } from 'drizzle-orm'

import type { AgentRuntimeContext } from './runtime'
import type {
  AgentCheckpoint,
  AgentResponder,
  AgentTask,
  AgentTools,
} from './types'

import {
  agentCommitmentDependencies,
  agentCommitments,
  agentMessages,
  agentRequests,
  agentRuns,
  agentToolCalls,
  type CommitmentExecutionSpec,
  type CommitmentSchedule,
} from '../schema'
import {
  agentToolApprovalRequired,
  approvedToolCapability,
  getAgentTool,
  invokeAgentTool,
} from './approvals'
import { assembleAgentContext } from './context'
import { acquireAgentThreadLock, releaseAgentThreadLock } from './runtime'

const explicitTimezone = /(Z|[+-]\d{2}:\d{2})$/i

export interface CreateCommitmentInput {
  threadId: string
  userId: string
  title: string
  dueAt?: string
  schedule?: CommitmentSchedule
  execution: CommitmentExecutionSpec
  dependsOn?: string[]
}

export function nextDueAt(
  schedule: CommitmentSchedule,
  fromDate: Date = new Date(),
): Date {
  if (schedule.kind === 'interval') {
    if (schedule.everySeconds < 1) {
      throw new Error('Interval everySeconds must be >= 1')
    }
    return new Date(fromDate.getTime() + schedule.everySeconds * 1000)
  }

  if (schedule.kind === 'cron') {
    const parsed = parseCron(schedule.expr)
    const startMs = Math.floor(fromDate.getTime() / 60000) * 60000 + 60000
    for (let offsetMinutes = 0; offsetMinutes < 525600; offsetMinutes++) {
      const candidateMs = startMs + offsetMinutes * 60000
      if (cronMatches(parsed, candidateMs)) {
        return new Date(candidateMs)
      }
    }
    throw new Error(
      `Could not find next matching occurrence for cron "${schedule.expr}"`,
    )
  }

  throw new Error(`Unknown schedule kind: ${(schedule as any).kind}`)
}

function parseDueAt(value: string) {
  if (!explicitTimezone.test(value)) {
    throw new Error('Commitment dueAt requires an explicit timezone')
  }
  const dueAt = new Date(value)
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error(`Invalid date format for dueAt: "${value}"`)
  }
  return dueAt
}

function validateExecution(execution: CommitmentExecutionSpec) {
  if (execution.kind === 'notify') {
    if (!execution.message.trim()) throw new Error('Notification is empty')
    return execution
  }
  if (execution.kind === 'objective') {
    if (!execution.prompt.trim()) throw new Error('Objective is empty')
    return execution
  }
  const definition = getAgentTool(execution.tool)
  return {
    ...execution,
    args: definition.inputSchema.parse(execution.args) as Record<
      string,
      unknown
    >,
  }
}

export async function createCommitment(
  ctx: AgentRuntimeContext,
  input: CreateCommitmentInput,
) {
  let dueAt: Date
  if (input.dueAt) {
    dueAt = parseDueAt(input.dueAt)
  } else if (input.schedule) {
    dueAt = nextDueAt(input.schedule)
  } else {
    throw new Error('Commitment requires either dueAt or schedule')
  }

  if (input.schedule) {
    if (input.schedule.kind === 'cron') {
      parseCron(input.schedule.expr)
    } else if (input.schedule.kind === 'interval') {
      if (input.schedule.everySeconds < 1) {
        throw new Error('Interval everySeconds must be at least 1')
      }
    }
  }

  const execution = validateExecution(input.execution)
  const dependencyIds = [...new Set(input.dependsOn ?? [])]
  if (dependencyIds.length > 0) {
    const dependencies = await ctx.db
      .select()
      .from(agentCommitments)
      .where(inArray(agentCommitments.id, dependencyIds))
      .all()
    if (
      dependencies.length !== dependencyIds.length ||
      dependencies.some(
        (row: typeof agentCommitments.$inferSelect) =>
          row.userId !== input.userId || row.threadId !== input.threadId,
      )
    ) {
      throw new Error('Commitment dependencies must belong to this agent')
    }
  }

  const id = generateTypeId('acommit')
  const initialStatus = dependencyIds.length > 0 ? 'blocked' : 'pending'
  const [commitment] = await ctx.db
    .insert(agentCommitments)
    .values({
      id,
      threadId: input.threadId,
      userId: input.userId,
      kind: execution.kind,
      title: input.title,
      schedule: input.schedule,
      executionSpec: execution,
      dueAt,
      status: initialStatus,
    })
    .returning()
  if (dependencyIds.length > 0) {
    await ctx.db.insert(agentCommitmentDependencies).values(
      dependencyIds.map((dependsOnCommitmentId) => ({
        commitmentId: id,
        dependsOnCommitmentId,
      })),
    )
  }
  await ctx.realtime.publish(agentCommitments, 'create', commitment)
  await ctx.jobs.enqueue(
    'agentCommitment',
    { commitmentId: id },
    { dedupeKey: `agent-commitment:${id}`, runAt: dueAt },
  )
  return commitment!
}

export async function listCommitments(
  ctx: AgentRuntimeContext,
  input: { threadId: string; userId: string; status?: string },
) {
  const predicates = [
    eq(agentCommitments.threadId, input.threadId),
    eq(agentCommitments.userId, input.userId),
  ]
  if (input.status) {
    predicates.push(eq(agentCommitments.status, input.status as any))
  }
  return ctx.db
    .select()
    .from(agentCommitments)
    .where(and(...predicates))
    .orderBy(asc(agentCommitments.dueAt), asc(agentCommitments.id))
    .all()
}

export async function cancelCommitment(
  ctx: AgentRuntimeContext,
  input: { commitmentId: string; userId: string },
) {
  const [commitment] = await ctx.db
    .update(agentCommitments)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        eq(agentCommitments.id, input.commitmentId),
        eq(agentCommitments.userId, input.userId),
        inArray(agentCommitments.status, ['pending', 'blocked', 'paused']),
      ),
    )
    .returning()
  if (!commitment) throw new Error('Cancellable commitment not found')
  await ctx.realtime.publish(agentCommitments, 'update', commitment)
  return commitment
}

export async function pauseCommitment(
  ctx: AgentRuntimeContext,
  input: { commitmentId: string; userId: string },
) {
  const [commitment] = await ctx.db
    .update(agentCommitments)
    .set({ status: 'paused' })
    .where(
      and(
        eq(agentCommitments.id, input.commitmentId),
        eq(agentCommitments.userId, input.userId),
        eq(agentCommitments.status, 'pending'),
      ),
    )
    .returning()
  if (!commitment) {
    throw new Error('Pausable commitment not found')
  }
  await ctx.realtime.publish(agentCommitments, 'update', commitment)
  return commitment
}

export async function resumeCommitment(
  ctx: AgentRuntimeContext,
  input: { commitmentId: string; userId: string },
) {
  const existing = await ctx.db
    .select()
    .from(agentCommitments)
    .where(
      and(
        eq(agentCommitments.id, input.commitmentId),
        eq(agentCommitments.userId, input.userId),
      ),
    )
    .get()
  if (!existing || existing.status !== 'paused') {
    throw new Error('Paused commitment not found')
  }
  const nextDue = existing.schedule
    ? nextDueAt(existing.schedule, new Date())
    : existing.dueAt
  const [commitment] = await ctx.db
    .update(agentCommitments)
    .set({ status: 'pending', dueAt: nextDue, error: null })
    .where(eq(agentCommitments.id, input.commitmentId))
    .returning()
  await ctx.realtime.publish(agentCommitments, 'update', commitment)
  await ctx.jobs.enqueue(
    'agentCommitment',
    { commitmentId: commitment.id },
    {
      dedupeKey: `agent-commitment:${commitment.id}:${nextDue.getTime()}`,
      runAt: nextDue,
    },
  )
  return commitment
}

export async function retryCommitment(
  ctx: AgentRuntimeContext,
  input: { commitmentId: string; userId: string },
) {
  const [commitment] = await ctx.db
    .update(agentCommitments)
    .set({
      status: 'pending',
      currentRunId: null,
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
    })
    .where(
      and(
        eq(agentCommitments.id, input.commitmentId),
        eq(agentCommitments.userId, input.userId),
        eq(agentCommitments.status, 'failed'),
      ),
    )
    .returning()
  if (!commitment) throw new Error('Failed commitment not found')
  await ctx.realtime.publish(agentCommitments, 'update', commitment)
  await ctx.jobs.enqueue(
    'agentCommitment',
    { commitmentId: commitment.id },
    { dedupeKey: `agent-commitment:${commitment.id}:retry:${Date.now()}` },
  )
  return commitment
}

async function releaseCompletedDependents(
  ctx: AgentRuntimeContext,
  completedCommitmentId: string,
) {
  const dependencyEdges = await ctx.db
    .select()
    .from(agentCommitmentDependencies)
    .where(
      eq(
        agentCommitmentDependencies.dependsOnCommitmentId,
        completedCommitmentId,
      ),
    )
    .all()
  const dependentIds = Array.from(
    new Set<string>(
      dependencyEdges.map(
        (edge: typeof agentCommitmentDependencies.$inferSelect) =>
          edge.commitmentId,
      ),
    ),
  )
  for (const dependentId of dependentIds) {
    const allEdges = await ctx.db
      .select()
      .from(agentCommitmentDependencies)
      .where(eq(agentCommitmentDependencies.commitmentId, dependentId))
      .all()
    const dependencies = await ctx.db
      .select()
      .from(agentCommitments)
      .where(
        inArray(
          agentCommitments.id,
          allEdges.map(
            (edge: typeof agentCommitmentDependencies.$inferSelect) =>
              edge.dependsOnCommitmentId,
          ),
        ),
      )
      .all()
    if (
      dependencies.length !== allEdges.length ||
      dependencies.some(
        (dependency: typeof agentCommitments.$inferSelect) =>
          dependency.status !== 'completed',
      )
    ) {
      continue
    }
    const [released] = await ctx.db
      .update(agentCommitments)
      .set({ status: 'pending', error: null })
      .where(
        and(
          eq(agentCommitments.id, dependentId),
          eq(agentCommitments.status, 'blocked'),
        ),
      )
      .returning()
    if (!released) continue
    await ctx.realtime.publish(agentCommitments, 'update', released)
    const runAt =
      released.dueAt.getTime() > Date.now() ? released.dueAt : undefined
    await ctx.jobs.enqueue(
      'agentCommitment',
      { commitmentId: released.id },
      {
        dedupeKey: `agent-commitment:${released.id}:dependencies-complete`,
        ...(runAt ? { runAt } : {}),
      },
    )
  }
}

async function executeCommitmentUnlocked(
  ctx: AgentRuntimeContext,
  input: { commitmentId: string; runId?: string; requestId?: string },
  responder?: AgentResponder,
) {
  let existing = await ctx.db
    .select()
    .from(agentCommitments)
    .where(eq(agentCommitments.id, input.commitmentId))
    .get()
  if (!existing) return { status: 'already_terminal' as const }

  if (existing.status === 'blocked') {
    const dependencies = await ctx.db
      .select()
      .from(agentCommitmentDependencies)
      .where(eq(agentCommitmentDependencies.commitmentId, input.commitmentId))
      .all()
    const dependencyRows = dependencies.length
      ? await ctx.db
          .select()
          .from(agentCommitments)
          .where(
            inArray(
              agentCommitments.id,
              dependencies.map(
                (row: typeof agentCommitmentDependencies.$inferSelect) =>
                  row.dependsOnCommitmentId,
              ),
            ),
          )
          .all()
      : []
    if (
      dependencyRows.length !== dependencies.length ||
      dependencyRows.some(
        (row: typeof agentCommitments.$inferSelect) =>
          row.status !== 'completed',
      )
    ) {
      return { status: 'blocked' as const }
    }
    ;[existing] = await ctx.db
      .update(agentCommitments)
      .set({ status: 'pending', error: null })
      .where(
        and(
          eq(agentCommitments.id, input.commitmentId),
          eq(agentCommitments.status, 'blocked'),
        ),
      )
      .returning()
  }

  let claimed: typeof agentCommitments.$inferSelect | undefined
  let run: typeof agentRuns.$inferSelect | undefined
  let resumeRequest: typeof agentRequests.$inferSelect | undefined
  let capabilities: ReturnType<typeof approvedToolCapability>[] = []
  if (input.runId || input.requestId) {
    if (!input.runId || !input.requestId) {
      throw new Error('Commitment resume requires runId and requestId')
    }
    const resumeRunId = input.runId
    resumeRequest = await ctx.db
      .select()
      .from(agentRequests)
      .where(
        and(
          eq(agentRequests.id, input.requestId),
          eq(agentRequests.runId, resumeRunId),
          eq(agentRequests.userId, existing.userId),
        ),
      )
      .get()
    if (
      !resumeRequest ||
      (resumeRequest.status !== 'approved' &&
        resumeRequest.status !== 'rejected') ||
      !resumeRequest.tool ||
      !resumeRequest.toolVersion ||
      !resumeRequest.toolCallId ||
      !resumeRequest.args ||
      !resumeRequest.approvalId
    ) {
      throw new Error('Resolved commitment approval request not found')
    }
    const resumed = await ctx.db.transaction(async (tx: any) => {
      const [nextCommitment] = await tx
        .update(agentCommitments)
        .set({ status: 'running', error: null })
        .where(
          and(
            eq(agentCommitments.id, input.commitmentId),
            eq(agentCommitments.currentRunId, resumeRunId),
            eq(agentCommitments.status, 'waiting_for_approval'),
          ),
        )
        .returning()
      if (!nextCommitment) return undefined
      const [nextRun] = await tx
        .update(agentRuns)
        .set({ status: 'running', error: null })
        .where(
          and(
            eq(agentRuns.id, resumeRunId),
            eq(agentRuns.commitmentId, input.commitmentId),
            eq(agentRuns.status, 'waiting_for_approval'),
          ),
        )
        .returning()
      if (!nextRun) throw new Error('Approval run is no longer resumable')
      return { commitment: nextCommitment, run: nextRun }
    })
    claimed = resumed?.commitment
    run = resumed?.run
    if (resumeRequest.status === 'approved') {
      capabilities = [
        approvedToolCapability({
          toolId: resumeRequest.tool,
          toolVersion: resumeRequest.toolVersion!,
          toolCallId: resumeRequest.toolCallId!,
          args: resumeRequest.args,
        }),
      ]
    }
  } else {
    const startedAt = new Date()
    const staleBefore = new Date(Date.now() - 10 * 60_000)
    const started = await ctx.db.transaction(async (tx: any) => {
      let [nextCommitment] = await tx
        .update(agentCommitments)
        .set({ status: 'running', startedAt, error: null })
        .where(
          and(
            eq(agentCommitments.id, input.commitmentId),
            eq(agentCommitments.status, 'pending'),
          ),
        )
        .returning()
      if (nextCommitment) {
        const [nextRun] = await tx
          .insert(agentRuns)
          .values({
            threadId: nextCommitment.threadId,
            userId: nextCommitment.userId,
            commitmentId: nextCommitment.id,
            triggerType: 'commitment',
            reason: 'commitment.due',
            status: 'running',
          })
          .returning()
        ;[nextCommitment] = await tx
          .update(agentCommitments)
          .set({ currentRunId: nextRun!.id })
          .where(eq(agentCommitments.id, nextCommitment.id))
          .returning()
        return { commitment: nextCommitment, run: nextRun, created: true }
      }

      ;[nextCommitment] = await tx
        .update(agentCommitments)
        .set({ startedAt, error: null })
        .where(
          and(
            eq(agentCommitments.id, input.commitmentId),
            eq(agentCommitments.status, 'running'),
            lt(agentCommitments.startedAt, staleBefore),
          ),
        )
        .returning()
      if (!nextCommitment?.currentRunId) return undefined
      const nextRun = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, nextCommitment.currentRunId))
        .get()
      if (!nextRun) throw new Error('Running commitment has no execution run')
      return { commitment: nextCommitment, run: nextRun, created: false }
    })
    claimed = started?.commitment
    run = started?.run
    if (started?.created) await ctx.realtime.publish(agentRuns, 'create', run)
    if (!started) {
      const running = await ctx.db
        .select()
        .from(agentCommitments)
        .where(eq(agentCommitments.id, input.commitmentId))
        .get()
      if (running?.status === 'running' && running.startedAt) {
        const recoverAt = new Date(running.startedAt.getTime() + 10 * 60_000)
        await ctx.jobs.enqueue(
          'agentCommitment',
          { commitmentId: running.id },
          {
            dedupeKey: `agent-commitment:${running.id}:recover:${recoverAt.getTime()}`,
            runAt: recoverAt,
          },
        )
        return { status: 'busy' as const }
      }
    }
  }
  if (!claimed || !run) return { status: 'already_terminal' as const }
  if (!claimed.executionSpec) {
    throw new Error('Commitment has no executable specification')
  }

  if (
    resumeRequest?.status === 'rejected' &&
    claimed.executionSpec.kind !== 'objective'
  ) {
    const completedAt = new Date()
    const error = 'The user rejected this commitment action.'
    const [failedRun] = await ctx.db
      .update(agentRuns)
      .set({ status: 'error', error, completedAt })
      .where(eq(agentRuns.id, run.id))
      .returning()
    const [failedCommitment] = await ctx.db
      .update(agentCommitments)
      .set({ status: 'failed', error, completedAt })
      .where(eq(agentCommitments.id, claimed.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', failedRun)
    await ctx.realtime.publish(agentCommitments, 'update', failedCommitment)
    return { status: 'rejected' as const }
  }

  try {
    let result: unknown
    if (claimed.executionSpec.kind === 'notify') {
      const notificationMessage = claimed.executionSpec.message
      const executionId = `${claimed.id}:${claimed.dueAt.getTime()}:notify`
      const previous = await ctx.db
        .select()
        .from(agentToolCalls)
        .where(eq(agentToolCalls.executionId, executionId))
        .get()
      if (previous?.status === 'done') {
        result = previous.result
      } else {
        const committed = await ctx.db.transaction(async (tx: any) => {
          const [call] = await tx
            .insert(agentToolCalls)
            .values({
              runId: run!.id,
              threadId: claimed!.threadId,
              userId: claimed!.userId,
              executionId,
              tool: 'notify',
              args: { message: notificationMessage },
              status: 'running',
            })
            .returning()
          const [message] = await tx
            .insert(agentMessages)
            .values({
              threadId: claimed!.threadId,
              userId: claimed!.userId,
              role: 'assistant',
              content: notificationMessage,
            })
            .returning()
          const nextResult = { messageId: message!.id }
          const [finishedCall] = await tx
            .update(agentToolCalls)
            .set({ status: 'done', result: nextResult })
            .where(eq(agentToolCalls.id, call!.id))
            .returning()
          return { message, call: finishedCall, result: nextResult }
        })
        await ctx.realtime.publish(agentMessages, 'create', committed.message)
        await ctx.realtime.publish(agentToolCalls, 'create', committed.call)
        result = committed.result
      }
    } else if (claimed.executionSpec.kind === 'tool_call') {
      const invocation = await invokeAgentTool(ctx, {
        toolId: claimed.executionSpec.tool,
        rawArgs: claimed.executionSpec.args,
        userId: claimed.userId,
        threadId: claimed.threadId,
        runId: run!.id,
        trigger: {
          type: 'system',
          trusted: true,
          sourceId: claimed.id,
        },
        capabilities,
        executionId: `${claimed.id}:${claimed.dueAt.getTime()}:tool`,
      })
      if (invocation.status === 'approval_required') {
        const [waitingRun] = await ctx.db
          .update(agentRuns)
          .set({ status: 'waiting_for_approval' })
          .where(eq(agentRuns.id, run!.id))
          .returning()
        const [waitingCommitment] = await ctx.db
          .update(agentCommitments)
          .set({ status: 'waiting_for_approval' })
          .where(eq(agentCommitments.id, claimed.id))
          .returning()
        await ctx.realtime.publish(agentRuns, 'update', waitingRun)
        await ctx.realtime.publish(
          agentCommitments,
          'update',
          waitingCommitment,
        )
        return {
          status: 'waiting_for_approval' as const,
          runId: run!.id,
          requestId: invocation.requestId,
        }
      }
      result = invocation.result
      if (resumeRequest?.status === 'approved') {
        const [resolved] = await ctx.db
          .update(agentRequests)
          .set({ result })
          .where(eq(agentRequests.id, resumeRequest.id))
          .returning()
        await ctx.realtime.publish(agentRequests, 'update', resolved)
      }
    } else {
      if (!responder) throw new Error('Objective commitment needs a responder')
      let invocationSequence =
        (run.checkpoint as AgentCheckpoint | null)?.toolSequence ?? 0
      const invoke = async (toolId: string, rawArgs: unknown) => {
        invocationSequence += 1
        const invocation = await invokeAgentTool(ctx, {
          toolId,
          rawArgs,
          userId: claimed.userId,
          threadId: claimed.threadId,
          runId: run.id,
          trigger: {
            type: 'system',
            trusted: true,
            sourceId: claimed.id,
          },
          capabilities,
          executionId: `${claimed.id}:${claimed.dueAt.getTime()}:objective:${invocationSequence}`,
        })
        if (
          invocation.status === 'done' &&
          resumeRequest?.status === 'approved' &&
          resumeRequest.tool === toolId
        ) {
          const [resolved] = await ctx.db
            .update(agentRequests)
            .set({ result: invocation.result })
            .where(eq(agentRequests.id, resumeRequest.id))
            .returning()
          await ctx.realtime.publish(agentRequests, 'update', resolved)
        }
        return invocation
      }
      const requireDone = async <T>(toolId: string, rawArgs: unknown) => {
        const invocation = await invoke(toolId, rawArgs)
        if (invocation.status !== 'done') {
          throw new Error(`${toolId} unexpectedly requires approval`)
        }
        return invocation.result as T
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
        pauseCommitment: (args) =>
          requireDone<unknown>('pauseCommitment', args),
        resumeCommitment: (args) =>
          requireDone<unknown>('resumeCommitment', args),
        retryCommitment: (args) =>
          requireDone<unknown>('retryCommitment', args),
        remember: (args) => requireDone('remember', args),
        deleteTask: async (args) => {
          const invocation = await invoke('deleteTask', args)
          return invocation.status === 'done'
            ? (invocation.result as AgentTask)
            : invocation
        },
      }
      const context = await assembleAgentContext(ctx, {
        thread: { id: claimed.threadId, userId: claimed.userId },
        reason: 'commitment.due',
        now: new Date(),
      })
      const response = await responder({
        ...context,
        currentExecution: {
          trigger: 'commitment',
          commitmentId: claimed.id,
          runId: run.id,
          objective: claimed.executionSpec.prompt,
          executionSpec: claimed.executionSpec,
        },
        checkpoint: (run.checkpoint as any) ?? undefined,
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
        tools,
        toolApprovalRequired: (toolId, rawArgs) =>
          agentToolApprovalRequired(ctx, {
            toolId,
            rawArgs,
            userId: claimed.userId,
            threadId: claimed.threadId,
            capabilities,
          }),
      })
      if (response.status === 'waiting_for_approval') {
        const definition = getAgentTool(response.request.tool)
        const [request] = await ctx.db
          .insert(agentRequests)
          .values({
            threadId: claimed.threadId,
            userId: claimed.userId,
            runId: run!.id,
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
        const [waitingRun] = await ctx.db
          .update(agentRuns)
          .set({
            status: 'waiting_for_approval',
            checkpoint: {
              ...response.checkpoint,
              toolSequence: invocationSequence,
            },
          })
          .where(eq(agentRuns.id, run!.id))
          .returning()
        const [waitingCommitment] = await ctx.db
          .update(agentCommitments)
          .set({ status: 'waiting_for_approval' })
          .where(eq(agentCommitments.id, claimed.id))
          .returning()
        await ctx.realtime.publish(agentRequests, 'create', request)
        await ctx.realtime.publish(agentRuns, 'update', waitingRun)
        await ctx.realtime.publish(
          agentCommitments,
          'update',
          waitingCommitment,
        )
        return {
          status: 'waiting_for_approval' as const,
          runId: run!.id,
          requestId: request!.id,
        }
      }
      if (response.status === 'blocked') {
        const [blockedRun] = await ctx.db
          .update(agentRuns)
          .set({
            status: 'error',
            error: response.reason,
            checkpoint: response.checkpoint,
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, run!.id))
          .returning()
        const [blockedCommitment] = await ctx.db
          .update(agentCommitments)
          .set({ status: 'blocked', error: response.reason })
          .where(eq(agentCommitments.id, claimed.id))
          .returning()
        await ctx.realtime.publish(agentRuns, 'update', blockedRun)
        await ctx.realtime.publish(
          agentCommitments,
          'update',
          blockedCommitment,
        )
        return { status: 'blocked' as const, reason: response.reason }
      }
      if (response.status === 'failed') {
        throw new Error(response.error)
      }
      if (response.text.trim()) {
        const [message] = await ctx.db
          .insert(agentMessages)
          .values({
            threadId: claimed.threadId,
            userId: claimed.userId,
            role: 'assistant',
            content: response.text,
          })
          .returning()
        await ctx.realtime.publish(agentMessages, 'create', message)
      }
      await ctx.db
        .update(agentRuns)
        .set({ checkpoint: response.checkpoint })
        .where(eq(agentRuns.id, run!.id))
      result = { summary: response.text }
    }

    const completedAt = new Date()
    const [finishedRun] = await ctx.db
      .update(agentRuns)
      .set({ status: 'complete', completedAt })
      .where(eq(agentRuns.id, run!.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', finishedRun)

    if (claimed.schedule) {
      const fromTime =
        claimed.schedule.kind === 'interval' &&
        claimed.dueAt.getTime() + claimed.schedule.everySeconds * 1000 >
          completedAt.getTime()
          ? claimed.dueAt
          : completedAt
      const nextDue = nextDueAt(claimed.schedule, fromTime)
      const [updatedCommitment] = await ctx.db
        .update(agentCommitments)
        .set({
          status: 'pending',
          dueAt: nextDue,
          currentRunId: null,
          result,
          error: null,
          completedAt,
        })
        .where(eq(agentCommitments.id, claimed.id))
        .returning()
      await ctx.realtime.publish(agentCommitments, 'update', updatedCommitment)
      await ctx.jobs.enqueue(
        'agentCommitment',
        { commitmentId: claimed.id },
        {
          dedupeKey: `agent-commitment:${claimed.id}:${nextDue.getTime()}`,
          runAt: nextDue,
        },
      )
      await releaseCompletedDependents(ctx, claimed.id)
      return { status: 'completed' as const, result, nextDueAt: nextDue }
    }

    const [finishedCommitment] = await ctx.db
      .update(agentCommitments)
      .set({ status: 'completed', result, completedAt })
      .where(eq(agentCommitments.id, claimed.id))
      .returning()
    await ctx.realtime.publish(agentCommitments, 'update', finishedCommitment)
    await releaseCompletedDependents(ctx, claimed.id)
    return { status: 'completed' as const, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const completedAt = new Date()
    const [failedRun] = await ctx.db
      .update(agentRuns)
      .set({ status: 'error', error: message, completedAt })
      .where(eq(agentRuns.id, run!.id))
      .returning()
    await ctx.realtime.publish(agentRuns, 'update', failedRun)

    if (claimed.schedule) {
      const fromTime =
        claimed.schedule.kind === 'interval' &&
        claimed.dueAt.getTime() + claimed.schedule.everySeconds * 1000 >
          completedAt.getTime()
          ? claimed.dueAt
          : completedAt
      const nextDue = nextDueAt(claimed.schedule, fromTime)
      const [updatedCommitment] = await ctx.db
        .update(agentCommitments)
        .set({
          status: 'pending',
          dueAt: nextDue,
          currentRunId: null,
          error: message,
          completedAt,
        })
        .where(eq(agentCommitments.id, claimed.id))
        .returning()
      await ctx.realtime.publish(agentCommitments, 'update', updatedCommitment)
      await ctx.jobs.enqueue(
        'agentCommitment',
        { commitmentId: claimed.id },
        {
          dedupeKey: `agent-commitment:${claimed.id}:${nextDue.getTime()}`,
          runAt: nextDue,
        },
      )
    } else {
      const [failedCommitment] = await ctx.db
        .update(agentCommitments)
        .set({ status: 'failed', error: message, completedAt })
        .where(eq(agentCommitments.id, claimed.id))
        .returning()
      await ctx.realtime.publish(agentCommitments, 'update', failedCommitment)
    }
    throw error
  }
}

export async function executeCommitment(
  ctx: AgentRuntimeContext,
  input: { commitmentId: string; runId?: string; requestId?: string },
  responder?: AgentResponder,
) {
  const commitment = await ctx.db
    .select()
    .from(agentCommitments)
    .where(eq(agentCommitments.id, input.commitmentId))
    .get()
  if (!commitment || commitment.executionSpec?.kind !== 'objective') {
    return executeCommitmentUnlocked(ctx, input, responder)
  }

  const thread = await acquireAgentThreadLock(ctx, commitment.threadId)
  if (!thread) {
    const retryAt = new Date(Date.now() + 1_000)
    await ctx.jobs.enqueue('agentCommitment', input, {
      dedupeKey: `agent-commitment:${input.commitmentId}:thread-busy:${retryAt.getTime()}`,
      runAt: retryAt,
    })
    return { status: 'busy' as const }
  }

  try {
    return await executeCommitmentUnlocked(ctx, input, responder)
  } finally {
    await releaseAgentThreadLock(ctx, thread, thread.wakeSeq)
  }
}
