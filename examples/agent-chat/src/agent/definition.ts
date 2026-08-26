import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { agentCommitments, tasks } from '../schema'
import { defineAgent, defineTool } from './declaration'

const listTasks = defineTool({
  id: 'listTasks',
  version: 1,
  description: 'List tasks owned by the current user.',
  inputSchema: z.object({}),
  approval: { mode: 'none' },
  execute: async (_input, ctx) =>
    ctx.runtime.db.select().from(tasks).where(eq(tasks.userId, ctx.userId)).all(),
})

const createTask = defineTool({
  id: 'createTask',
  version: 1,
  description: 'Create a task for the current user.',
  inputSchema: z.object({ title: z.string().trim().min(1) }),
  approval: { mode: 'none' },
  execute: async ({ title }, ctx) => {
    const [task] = await ctx.runtime.db
      .insert(tasks)
      .values({ userId: ctx.userId, title })
      .returning()
    await ctx.runtime.realtime.publish(tasks, 'create', task)
    return task!
  },
})

const completeTask = defineTool({
  id: 'completeTask',
  version: 1,
  description: 'Complete one task owned by the current user.',
  inputSchema: z.object({ taskId: z.string().min(1) }),
  approval: { mode: 'none' },
  execute: async ({ taskId }, ctx) => {
    const [task] = await ctx.runtime.db
      .update(tasks)
      .set({ done: true, completedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, ctx.userId)))
      .returning()
    if (!task) throw new Error('Task not found')
    await ctx.runtime.realtime.publish(tasks, 'update', task)
    return task
  },
})

const scheduleReminder = defineTool({
  id: 'scheduleReminder',
  version: 1,
  description: 'Schedule a future reminder for the current user.',
  inputSchema: z.object({
    title: z.string().trim().min(1),
    dueAt: z.coerce.date(),
  }),
  approval: { mode: 'none' },
  execute: async ({ title, dueAt }, ctx) => {
    const [commitment] = await ctx.runtime.db
      .insert(agentCommitments)
      .values({
        threadId: ctx.threadId,
        userId: ctx.userId,
        kind: 'reminder',
        title,
        dueAt,
      })
      .returning()
    await ctx.runtime.realtime.publish(
      agentCommitments,
      'create',
      commitment,
    )
    await ctx.runtime.jobs.enqueue(
      'agentReminder',
      { commitmentId: commitment!.id },
      { runAt: dueAt },
    )
    return commitment!
  },
})

export const agentDefinition = defineAgent({
  instructions: ({ now }) =>
    [
      'You are a concise personal task agent.',
      `Current time is ${now.toISOString()}.`,
      'Use tools for every read or mutation; never claim an effect you did not perform.',
    ].join('\n'),
  tools: { listTasks, createTask, completeTask, scheduleReminder },
  events: {},
  context: {
    conversation: { recent: 20 },
    inbox: { maxItems: 10 },
    memory: { maxItems: 8 },
  },
})
