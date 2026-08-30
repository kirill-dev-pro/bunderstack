import { and, asc, desc, eq, notInArray } from 'drizzle-orm'

import type { AgentRuntimeContext } from './runtime'
import type { AgentResponderInput, AgentTask } from './types'

import { agentCommitments, agentMemory, agentMessages, tasks } from '../schema'
import { agentDefinition } from './definition'
import { selectInboxContext } from './inbox'

export async function assembleAgentContext(
  ctx: AgentRuntimeContext,
  input: {
    thread: { id: string; userId: string }
    reason: string
    now: Date
  },
): Promise<
  Omit<
    AgentResponderInput,
    'currentExecution' | 'toolApprovalRequired' | 'stream'
  > & {
    selectedInboxIds: string[]
  }
> {
  const conversationLimit = agentDefinition.context.conversation.recent
  const recentMessages = (await ctx.db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.threadId, input.thread.id))
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
    .limit(conversationLimit)
    .all()) as Array<typeof agentMessages.$inferSelect>
  recentMessages.reverse()

  const memory = (await ctx.db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.userId, input.thread.userId))
    .orderBy(desc(agentMemory.updatedAt), desc(agentMemory.id))
    .limit(agentDefinition.context.memory.maxItems)
    .all()) as Array<typeof agentMemory.$inferSelect>
  const currentTasks = (await ctx.db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, input.thread.userId))
    .orderBy(asc(tasks.createdAt))
    .all()) as AgentTask[]
  const inbox = await selectInboxContext(ctx, {
    threadId: input.thread.id,
    userId: input.thread.userId,
    limit: agentDefinition.context.inbox.maxItems,
    now: input.now,
  })
  const activeCommitments = await ctx.db
    .select()
    .from(agentCommitments)
    .where(
      and(
        eq(agentCommitments.userId, input.thread.userId),
        eq(agentCommitments.threadId, input.thread.id),
        notInArray(agentCommitments.status, [
          'completed',
          'failed',
          'cancelled',
          'fired',
        ]),
      ),
    )
    .orderBy(asc(agentCommitments.dueAt), asc(agentCommitments.id))
    .all()
  const triggerType = input.reason.startsWith('message') ? 'user' : 'system'

  return {
    reason: input.reason,
    now: input.now,
    instructions: agentDefinition.instructions({ now: input.now }),
    trigger: {
      type: triggerType,
      trusted: true,
      reason: input.reason,
    },
    latestMessage: recentMessages.at(-1)?.content ?? '',
    messages: recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    tasks: currentTasks,
    memory: memory.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      value: row.value,
      sourceType: row.sourceType,
    })),
    inbox: inbox.items,
    activeCommitments: activeCommitments.map(
      (commitment: typeof agentCommitments.$inferSelect) => ({
        id: commitment.id,
        title: commitment.title,
        status: commitment.status,
        dueAt: commitment.dueAt,
        executionSpec: commitment.executionSpec,
      }),
    ),
    selectedInboxIds: inbox.selectedIds,
    tools: {} as AgentResponderInput['tools'],
  }
}
