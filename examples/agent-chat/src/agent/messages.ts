import { generateTypeId } from 'bunderstack'
import { and, eq, inArray } from 'drizzle-orm'

import { agentMessages, agentRuns } from '../schema'
import type { AgentRuntimeContext } from './runtime'
import { getOrCreateThread } from './runtime'

export interface AcceptedUserMessage {
  messageId: string
  threadId: string
  runId: string
  assistantMessageId: string
}

export class ActiveUserMessageRunError extends Error {
  constructor() {
    super('A user message is already being processed')
    this.name = 'ActiveUserMessageRunError'
  }
}

const activeStatuses = [
  'queued',
  'running',
  'waiting_for_approval',
  'cancelling',
] as const

const acceptanceLocks = new Map<string, Promise<void>>()

async function findAcceptedMessage(
  db: any,
  threadId: string,
  clientMessageId: string,
): Promise<AcceptedUserMessage | undefined> {
  const message = await db
    .select({ id: agentMessages.id })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.threadId, threadId),
        eq(agentMessages.clientMessageId, clientMessageId),
      ),
    )
    .get()
  if (!message) return undefined

  const run = await db
    .select({
      id: agentRuns.id,
      assistantMessageId: agentRuns.assistantMessageId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.inputMessageId, message.id))
    .get()
  if (!run?.assistantMessageId) {
    throw new Error('Accepted user message is missing its run')
  }
  return {
    messageId: message.id,
    threadId,
    runId: run.id,
    assistantMessageId: run.assistantMessageId,
  }
}

async function hasActiveUserMessageRun(db: any, threadId: string) {
  return Boolean(
    await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.threadId, threadId),
          eq(agentRuns.triggerType, 'user_message'),
          inArray(agentRuns.status, activeStatuses),
        ),
      )
      .get(),
  )
}

export async function acceptUserMessage(
  ctx: AgentRuntimeContext,
  input: { userId: string; content: string; clientMessageId: string },
): Promise<AcceptedUserMessage> {
  const thread = await getOrCreateThread(ctx.db, input.userId)
  const previous = acceptanceLocks.get(thread.id)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  acceptanceLocks.set(thread.id, current)
  await previous

  try {
    return await acceptUserMessageForThread(ctx, input, thread.id)
  } finally {
    release()
    if (acceptanceLocks.get(thread.id) === current) {
      acceptanceLocks.delete(thread.id)
    }
  }
}

async function acceptUserMessageForThread(
  ctx: AgentRuntimeContext,
  input: { userId: string; content: string; clientMessageId: string },
  threadId: string,
): Promise<AcceptedUserMessage> {
  const existing = await findAcceptedMessage(
    ctx.db,
    threadId,
    input.clientMessageId,
  )
  if (existing) {
    await enqueueAcceptedRun(ctx, existing)
    return existing
  }
  if (await hasActiveUserMessageRun(ctx.db, threadId)) {
    throw new ActiveUserMessageRunError()
  }

  const messageId = generateTypeId('amsg')
  const runId = generateTypeId('arun')
  const assistantMessageId = generateTypeId('amsg')
  let created:
    | {
        accepted: AcceptedUserMessage
        userMessage: typeof agentMessages.$inferSelect
        run: typeof agentRuns.$inferSelect
        assistantMessage: typeof agentMessages.$inferSelect
      }
    | undefined

  try {
    created = await ctx.db.transaction(async (tx: any) => {
      const duplicate = await findAcceptedMessage(
        tx,
        threadId,
        input.clientMessageId,
      )
      if (duplicate) return undefined
      if (await hasActiveUserMessageRun(tx, threadId)) {
        throw new ActiveUserMessageRunError()
      }

      const [userMessage] = await tx
        .insert(agentMessages)
        .values({
          id: messageId,
          threadId,
          userId: input.userId,
          role: 'user',
          content: input.content,
          clientMessageId: input.clientMessageId,
          status: 'complete',
        })
        .returning()
      const [run] = await tx
        .insert(agentRuns)
        .values({
          id: runId,
          threadId,
          userId: input.userId,
          inputMessageId: messageId,
          assistantMessageId,
          triggerType: 'user_message',
          reason: 'message',
          status: 'queued',
        })
        .returning()
      const [assistantMessage] = await tx
        .insert(agentMessages)
        .values({
          id: assistantMessageId,
          threadId,
          userId: input.userId,
          runId,
          role: 'assistant',
          content: '',
          status: 'queued',
        })
        .returning()

      return {
        accepted: { messageId, threadId, runId, assistantMessageId },
        userMessage: userMessage!,
        run: run!,
        assistantMessage: assistantMessage!,
      }
    })
  } catch (error) {
    const accepted = await findAcceptedMessage(
      ctx.db,
      threadId,
      input.clientMessageId,
    )
    if (accepted) {
      await enqueueAcceptedRun(ctx, accepted)
      return accepted
    }
    if (
      error instanceof ActiveUserMessageRunError ||
      (await hasActiveUserMessageRun(ctx.db, threadId))
    ) {
      throw new ActiveUserMessageRunError()
    }
    throw error
  }

  const accepted =
    created?.accepted ??
    (await findAcceptedMessage(ctx.db, threadId, input.clientMessageId))
  if (!accepted) throw new Error('Message acceptance did not commit')

  if (created) {
    await ctx.realtime.publish(agentMessages, 'create', created.userMessage)
    await ctx.realtime.publish(agentRuns, 'create', created.run)
    await ctx.realtime.publish(
      agentMessages,
      'create',
      created.assistantMessage,
    )
  }
  await enqueueAcceptedRun(ctx, accepted)
  return accepted
}

async function enqueueAcceptedRun(
  ctx: AgentRuntimeContext,
  accepted: AcceptedUserMessage,
) {
  await ctx.jobs.enqueue(
    'agentTurn',
    {
      threadId: accepted.threadId,
      reason: 'message',
      runId: accepted.runId,
      executionKey: accepted.runId,
    },
    { dedupeKey: `agent-run:${accepted.runId}` },
  )
}
