import { generateTypeId } from 'bunderstack'
import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'

import type { ToolDefinition, ToolExecutionContext } from './declaration'
import type { AgentRuntimeContext } from './runtime'

import {
  agentRequests,
  agentRuns,
  agentToolCalls,
  agentToolGrants,
} from '../schema'
import { agentDefinition } from './definition'
import {
  allowTool,
  evaluateToolPermission,
  type ToolCapability,
  type ToolGrant,
} from './policy'

export type ToolInvocationResult<T = unknown> =
  | { status: 'done'; result: T }
  | { status: 'approval_required'; requestId: string }

type AnyToolDefinition = ToolDefinition<string, any, any>
const APPROVAL_TTL_MS = 15 * 60_000

export function getAgentTool(toolId: string): AnyToolDefinition {
  const definition = agentDefinition.tools[
    toolId as keyof typeof agentDefinition.tools
  ] as AnyToolDefinition | undefined
  if (!definition) throw new Error(`Unknown agent tool: ${toolId}`)
  return definition
}

async function evaluateInvocation(
  ctx: AgentRuntimeContext,
  input: {
    toolId: string
    rawArgs: unknown
    userId: string
    threadId: string
    capabilities?: ToolCapability[]
  },
) {
  const definition = getAgentTool(input.toolId)
  const parsed = definition.inputSchema.parse(input.rawArgs) as Record<
    string,
    unknown
  >
  const grants = (await ctx.db
    .select()
    .from(agentToolGrants)
    .where(
      and(
        eq(agentToolGrants.userId, input.userId),
        eq(agentToolGrants.threadId, input.threadId),
        eq(agentToolGrants.tool, definition.id),
        eq(agentToolGrants.toolVersion, definition.version),
      ),
    )
    .all()) as ToolGrant[]
  const permission = evaluateToolPermission({
    tool: definition,
    args: parsed,
    userId: input.userId,
    threadId: input.threadId,
    grants,
    capabilities: input.capabilities ?? [],
  })
  return { definition, parsed, permission }
}

export async function agentToolApprovalRequired(
  ctx: AgentRuntimeContext,
  input: {
    toolId: string
    rawArgs: unknown
    userId: string
    threadId: string
    capabilities?: ToolCapability[]
  },
) {
  const { permission } = await evaluateInvocation(ctx, input)
  return permission.decision === 'approval_required'
}

export function approvedToolCapability(input: {
  toolId: string
  toolVersion: number
  toolCallId: string
  args: unknown
}) {
  const definition = getAgentTool(input.toolId)
  if (definition.version !== input.toolVersion) {
    throw new Error('Approved tool version is no longer available')
  }
  const parsed = definition.inputSchema.parse(input.args) as Record<
    string,
    unknown
  >
  return allowTool(definition, parsed, input.toolCallId)
}

async function recordExecution(
  ctx: AgentRuntimeContext,
  details: {
    runId: string
    threadId: string
    userId: string
    executionId: string
    trigger: ToolExecutionContext['trigger']
  },
  definition: AnyToolDefinition,
  args: Record<string, unknown>,
) {
  const existing = await ctx.db
    .select()
    .from(agentToolCalls)
    .where(eq(agentToolCalls.executionId, details.executionId))
    .get()
  if (
    existing &&
    (existing.threadId !== details.threadId ||
      existing.userId !== details.userId ||
      existing.tool !== definition.id ||
      !isDeepStrictEqual(existing.args, args))
  ) {
    throw new Error(`Tool execution identity collision: ${details.executionId}`)
  }
  if (existing?.status === 'done') return existing.result
  if (existing?.status === 'running') {
    throw new Error(
      `Tool execution ${details.executionId} has an indeterminate prior outcome`,
    )
  }
  if (existing?.status === 'failed') {
    await ctx.db
      .delete(agentToolCalls)
      .where(eq(agentToolCalls.id, existing.id))
  }

  try {
    const { call, result } = await ctx.db.transaction(async (tx: any) => {
      const [started] = await tx
        .insert(agentToolCalls)
        .values({
          runId: details.runId,
          threadId: details.threadId,
          userId: details.userId,
          executionId: details.executionId,
          tool: definition.id,
          args,
          status: 'running',
        })
        .returning()
      const result = await definition.execute(args, {
        runtime: { ...ctx, db: tx },
        userId: details.userId,
        threadId: details.threadId,
        runId: details.runId,
        executionId: details.executionId,
        idempotencyKey: details.executionId,
        trigger: details.trigger,
      })
      const [call] = await tx
        .update(agentToolCalls)
        .set({ result, status: 'done' })
        .where(eq(agentToolCalls.id, started!.id))
        .returning()
      return { call, result }
    })
    await ctx.realtime.publish(agentToolCalls, 'create', call)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const [call] = await ctx.db
      .insert(agentToolCalls)
      .values({
        runId: details.runId,
        threadId: details.threadId,
        userId: details.userId,
        executionId: details.executionId,
        tool: definition.id,
        args,
        status: 'failed',
        error: message,
      })
      .returning()
    await ctx.realtime.publish(agentToolCalls, 'create', call)
    throw error
  }
}

export async function invokeAgentTool(
  ctx: AgentRuntimeContext,
  input: {
    toolId: string
    rawArgs: unknown
    userId: string
    threadId: string
    runId: string
    trigger: ToolExecutionContext['trigger']
    capabilities?: ToolCapability[]
    executionId?: string
  },
): Promise<ToolInvocationResult> {
  const { definition, parsed, permission } = await evaluateInvocation(
    ctx,
    input,
  )

  if (permission.decision === 'deny') {
    throw new Error(permission.reason)
  }
  if (permission.decision === 'approval_required') {
    const requestId = generateTypeId('arequest')
    const [request] = await ctx.db
      .insert(agentRequests)
      .values({
        id: requestId,
        threadId: input.threadId,
        userId: input.userId,
        runId: input.runId,
        kind: 'approval',
        prompt: `Allow ${definition.id} with these exact arguments?`,
        tool: definition.id,
        toolVersion: definition.version,
        args: parsed,
        approvalId: `local:${requestId}`,
        toolCallId: `local:${requestId}`,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      })
      .returning()
    await ctx.realtime.publish(agentRequests, 'create', request)
    return { status: 'approval_required', requestId: request!.id }
  }

  if (permission.authorizedBy === 'grant') {
    await ctx.db
      .update(agentToolGrants)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentToolGrants.id, permission.grantId))
  }
  if (permission.authorizedBy === 'capability') {
    // Capabilities represent one frozen approval, not a reusable permission.
    // Consume before executing so even a responder that repeats an identical
    // call during the same resumed loop must ask again.
    permission.capability.consumed = true
  }

  const result = await recordExecution(
    ctx,
    {
      runId: input.runId,
      threadId: input.threadId,
      userId: input.userId,
      executionId:
        permission.authorizedBy === 'capability'
          ? permission.capability.toolCallId
          : (input.executionId ?? generateTypeId('acall')),
      trigger: input.trigger,
    },
    definition,
    parsed,
  )
  return { status: 'done', result }
}

export async function resolveApproval(
  ctx: AgentRuntimeContext,
  input: {
    requestId: string
    userId: string
    decision: 'allow_once' | 'always_allow' | 'reject'
  },
): Promise<
  | { status: 'resuming' | 'rejected' }
  | {
      status: 'already_resolved'
    }
> {
  const request = await ctx.db
    .select()
    .from(agentRequests)
    .where(
      and(
        eq(agentRequests.id, input.requestId),
        eq(agentRequests.userId, input.userId),
      ),
    )
    .get()
  if (!request) throw new Error('Approval request not found')
  if (request.status !== 'pending') return { status: 'already_resolved' }

  if (
    input.decision !== 'reject' &&
    (!request.expiresAt || request.expiresAt <= new Date())
  ) {
    const [expired] = await ctx.db
      .update(agentRequests)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(
        and(
          eq(agentRequests.id, request.id),
          eq(agentRequests.userId, input.userId),
          eq(agentRequests.status, 'pending'),
        ),
      )
      .returning()
    if (expired) await ctx.realtime.publish(agentRequests, 'update', expired)
    return { status: 'already_resolved' }
  }

  if (
    !request.tool ||
    !request.toolVersion ||
    !request.args ||
    !request.approvalId ||
    !request.toolCallId
  ) {
    throw new Error('Approval request does not contain a frozen tool call')
  }
  const definition = getAgentTool(request.tool)
  if (definition.version !== request.toolVersion) {
    throw new Error('Approved tool version is no longer available')
  }

  const nextStatus = input.decision === 'reject' ? 'rejected' : 'approved'
  const [claimed] = await ctx.db
    .update(agentRequests)
    .set({ status: nextStatus, resolvedAt: new Date() })
    .where(
      and(
        eq(agentRequests.id, request.id),
        eq(agentRequests.userId, input.userId),
        eq(agentRequests.status, 'pending'),
      ),
    )
    .returning()
  if (!claimed) return { status: 'already_resolved' }

  if (input.decision === 'always_allow') {
    const [grant] = await ctx.db
      .insert(agentToolGrants)
      .values({
        threadId: request.threadId,
        userId: request.userId,
        tool: definition.id,
        toolVersion: definition.version,
        scope: {},
      })
      .returning()
    await ctx.realtime.publish(agentToolGrants, 'create', grant)
  }

  await ctx.realtime.publish(agentRequests, 'update', claimed)
  const run = await ctx.db
    .select({ commitmentId: agentRuns.commitmentId })
    .from(agentRuns)
    .where(eq(agentRuns.id, request.runId))
    .get()
  if (run?.commitmentId) {
    await ctx.jobs.enqueue(
      'agentCommitment',
      {
        commitmentId: run.commitmentId,
        runId: request.runId,
        requestId: request.id,
      },
      { dedupeKey: `agent-run:${request.runId}:resume:${request.id}` },
    )
  } else {
    await ctx.jobs.enqueue(
      'agentTurn',
      {
        threadId: request.threadId,
        reason: 'tool.approval_resolved',
        runId: request.runId,
        requestId: request.id,
      },
      { dedupeKey: `agent-run:${request.runId}:resume:${request.id}` },
    )
  }
  return {
    status: input.decision === 'reject' ? 'rejected' : 'resuming',
  }
}

export async function revokeToolGrant(
  ctx: AgentRuntimeContext,
  input: { grantId: string; userId: string },
): Promise<boolean> {
  const [grant] = await ctx.db
    .update(agentToolGrants)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(agentToolGrants.id, input.grantId),
        eq(agentToolGrants.userId, input.userId),
        eq(agentToolGrants.status, 'active'),
      ),
    )
    .returning()
  if (!grant) return false
  await ctx.realtime.publish(agentToolGrants, 'update', grant)
  return true
}
