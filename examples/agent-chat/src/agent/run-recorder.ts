import { desc, eq, sql } from 'drizzle-orm'

import {
  agentMessages,
  agentRunSteps,
  type AgentMessageStatus,
  type AgentRunStepKind,
  type AgentRunStepVisibility,
  type agentRuns,
} from '../schema'
import type { AgentRuntimeContext } from './runtime'

export interface RunRecorderOptions {
  flushMs?: number
  now?: () => number
  schedule?: (
    callback: () => Promise<void>,
    delayMs: number,
  ) => unknown
  cancelScheduled?: (handle: unknown) => void
}

export interface StartRunStepInput {
  kind: AgentRunStepKind
  title: string
  detail?: unknown
  input?: unknown
  visibility?: AgentRunStepVisibility
}

export async function createRunRecorder(
  ctx: AgentRuntimeContext,
  run: typeof agentRuns.$inferSelect,
  options: RunRecorderOptions = {},
) {
  if (!run.assistantMessageId) {
    throw new Error('Run recorder requires a reserved assistant message')
  }
  const message = await ctx.db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.id, run.assistantMessageId))
    .get()
  if (!message) throw new Error('Reserved assistant message not found')

  const latestStep = await ctx.db
    .select({ sequence: agentRunSteps.sequence })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, run.id))
    .orderBy(desc(agentRunSteps.sequence))
    .limit(1)
    .get()

  const flushMs = options.flushMs ?? 150
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((callback: () => Promise<void>, delayMs: number) =>
      setTimeout(() => void callback(), delayMs))
  const cancelScheduled =
    options.cancelScheduled ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let content = message.content
  let persistedContent = message.content
  let lastFlushAt: number | undefined
  let scheduledFlush: unknown
  let backgroundError: unknown
  let nextSequence = latestStep?.sequence ?? 0
  let writeChain = Promise.resolve()

  const persistSnapshot = (snapshot: string) => {
    writeChain = writeChain.then(async () => {
      if (snapshot === persistedContent) return
      const [updated] = await ctx.db
        .update(agentMessages)
        .set({
          content: snapshot,
          status: 'streaming',
          revision: sql`${agentMessages.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(agentMessages.id, run.assistantMessageId!))
        .returning()
      if (!updated) throw new Error('Reserved assistant message disappeared')
      persistedContent = snapshot
      lastFlushAt = now()
      await ctx.realtime.publish(agentMessages, 'update', updated)
    })
    return writeChain
  }

  const scheduleTrailingFlush = () => {
    if (scheduledFlush !== undefined) return
    const elapsed = lastFlushAt === undefined ? flushMs : now() - lastFlushAt
    const delayMs = Math.max(0, flushMs - elapsed)
    scheduledFlush = schedule(async () => {
      scheduledFlush = undefined
      try {
        await persistSnapshot(content)
      } catch (error) {
        backgroundError = error
      }
    }, delayMs)
  }

  const throwBackgroundError = () => {
    if (backgroundError !== undefined) throw backgroundError
  }

  const flush = async () => {
    throwBackgroundError()
    if (scheduledFlush !== undefined) {
      cancelScheduled(scheduledFlush)
      scheduledFlush = undefined
    }
    await writeChain
    if (content !== persistedContent) await persistSnapshot(content)
    throwBackgroundError()
  }

  return {
    get content() {
      return content
    },

    async appendText(delta: string) {
      throwBackgroundError()
      if (!delta) return
      content += delta
      if (
        lastFlushAt === undefined ||
        now() - lastFlushAt >= flushMs
      ) {
        if (scheduledFlush !== undefined) {
          cancelScheduled(scheduledFlush)
          scheduledFlush = undefined
        }
        await persistSnapshot(content)
      } else {
        scheduleTrailingFlush()
      }
    },

    async replaceText(text: string) {
      throwBackgroundError()
      content = text
    },

    flush,

    async startStep(input: StartRunStepInput) {
      nextSequence += 1
      const [step] = await ctx.db
        .insert(agentRunSteps)
        .values({
          runId: run.id,
          threadId: run.threadId,
          userId: run.userId,
          sequence: nextSequence,
          kind: input.kind,
          title: input.title,
          detail: input.detail,
          input: input.input,
          visibility: input.visibility ?? 'visible',
          status: 'running',
        })
        .returning()
      await ctx.realtime.publish(agentRunSteps, 'create', step!)
      return step!
    },

    async finishStep(
      id: string,
      output?: unknown,
      options: { toolCallId?: string } = {},
    ) {
      const [step] = await ctx.db
        .update(agentRunSteps)
        .set({
          status: 'complete',
          output,
          toolCallId: options.toolCallId,
          completedAt: new Date(),
        })
        .where(eq(agentRunSteps.id, id))
        .returning()
      if (!step) throw new Error('Run step not found')
      await ctx.realtime.publish(agentRunSteps, 'update', step)
      return step
    },

    async failStep(id: string, error: unknown) {
      const [step] = await ctx.db
        .update(agentRunSteps)
        .set({
          status: 'failed',
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
          completedAt: new Date(),
        })
        .where(eq(agentRunSteps.id, id))
        .returning()
      if (!step) throw new Error('Run step not found')
      await ctx.realtime.publish(agentRunSteps, 'update', step)
      return step
    },

    async finishMessage(status: AgentMessageStatus) {
      await flush()
      const [updated] = await ctx.db
        .update(agentMessages)
        .set({
          status,
          revision: sql`${agentMessages.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(agentMessages.id, run.assistantMessageId!))
        .returning()
      if (!updated) throw new Error('Reserved assistant message disappeared')
      await ctx.realtime.publish(agentMessages, 'update', updated)
      return updated
    },
  }
}

export type RunRecorder = Awaited<ReturnType<typeof createRunRecorder>>
