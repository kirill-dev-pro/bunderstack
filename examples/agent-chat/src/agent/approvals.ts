import { and, eq } from 'drizzle-orm'
import { generateTypeId } from 'bunderstack'

import {
  agentRequests,
  agentToolCalls,
  agentToolGrants,
} from '../schema'
import type { ToolDefinition, ToolExecutionContext } from './declaration'
import { agentDefinition } from './definition'
import {
  allowTool,
  evaluateToolPermission,
  type ToolCapability,
  type ToolGrant,
} from './policy'
import { wakeAgent, type AgentRuntimeContext } from './runtime'

export type ToolInvocationResult<T = unknown> =
  | { status: 'done'; result: T }
  | { status: 'approval_required'; requestId: string }

type AnyToolDefinition = ToolDefinition<string, any, any>

function getTool(toolId: string): AnyToolDefinition {
  const definition = agentDefinition.tools[
    toolId as keyof typeof agentDefinition.tools
  ] as AnyToolDefinition | undefined
  if (!definition) throw new Error(`Unknown agent tool: ${toolId}`)
  return definition
}

async function recordExecution(
  ctx: AgentRuntimeContext,
  details: { runId: string; threadId: string; userId: string },
  definition: AnyToolDefinition,
  args: Record<string, unknown>,
  execute: () => Promise<unknown>,
) {
  try {
    const result = await execute()
    const [call] = await ctx.db
      .insert(agentToolCalls)
      .values({
        ...details,
        tool: definition.id,
        args,
        result,
        status: 'done',
      })
      .returning()
    await ctx.realtime.publish(agentToolCalls, 'create', call)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const [call] = await ctx.db
      .insert(agentToolCalls)
      .values({
        ...details,
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
  },
): Promise<ToolInvocationResult> {
  const definition = getTool(input.toolId)
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

  if (permission.decision === 'deny') {
    throw new Error(permission.reason)
  }
  if (permission.decision === 'approval_required') {
    const [request] = await ctx.db
      .insert(agentRequests)
      .values({
        id: generateTypeId('arequest'),
        threadId: input.threadId,
        userId: input.userId,
        runId: input.runId,
        kind: 'approval',
        prompt: `Allow ${definition.id} with these exact arguments?`,
        tool: definition.id,
        toolVersion: definition.version,
        args: parsed,
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

  const result = await recordExecution(
    ctx,
    {
      runId: input.runId,
      threadId: input.threadId,
      userId: input.userId,
    },
    definition,
    parsed,
    () =>
      definition.execute(parsed, {
        runtime: ctx,
        userId: input.userId,
        threadId: input.threadId,
        runId: input.runId,
        trigger: input.trigger,
      }),
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
  { status: 'executed' | 'rejected'; result?: unknown } | {
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

  if (input.decision === 'reject') {
    await ctx.realtime.publish(agentRequests, 'update', claimed)
    await wakeAgent(ctx, request.threadId, 'tool.approval_resolved')
    return { status: 'rejected' }
  }

  if (!request.tool || !request.toolVersion || !request.args) {
    throw new Error('Approval request does not contain a frozen tool call')
  }
  const definition = getTool(request.tool)
  if (definition.version !== request.toolVersion) {
    throw new Error('Approved tool version is no longer available')
  }

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

  const execution = await invokeAgentTool(ctx, {
    toolId: definition.id,
    rawArgs: request.args,
    userId: request.userId,
    threadId: request.threadId,
    runId: request.runId,
    trigger: { type: 'system', trusted: true, sourceId: request.id },
    capabilities: [allowTool(definition, request.args)],
  })
  if (execution.status !== 'done') {
    throw new Error('Frozen approval did not authorize its exact tool call')
  }
  const [resolved] = await ctx.db
    .update(agentRequests)
    .set({ result: execution.result })
    .where(eq(agentRequests.id, request.id))
    .returning()
  await ctx.realtime.publish(agentRequests, 'update', resolved)
  await wakeAgent(ctx, request.threadId, 'tool.approval_resolved')
  return { status: 'executed', result: execution.result }
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
