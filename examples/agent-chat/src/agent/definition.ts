import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { agentCommitments, tasks } from '../schema'
import { defineAgent, defineTool } from './declaration'
import { remember as storeMemory } from './memory'

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
    dueAt: z
      .string()
      .trim()
      .min(1)
      .describe(
        'ISO 8601 date string when the reminder is due (e.g. 2026-08-26T18:00:00.000Z)',
      ),
  }),
  approval: { mode: 'none' },
  execute: async ({ title, dueAt }, ctx) => {
    const dueAtDate = new Date(dueAt)
    if (isNaN(dueAtDate.getTime())) {
      throw new Error(`Invalid date format for dueAt: "${dueAt}"`)
    }
    const [commitment] = await ctx.runtime.db
      .insert(agentCommitments)
      .values({
        threadId: ctx.threadId,
        userId: ctx.userId,
        kind: 'reminder',
        title,
        dueAt: dueAtDate,
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
      { runAt: dueAtDate },
    )
    return commitment!
  },
})

const deleteTask = defineTool({
  id: 'deleteTask',
  version: 1,
  description: 'Delete one task owned by the current user.',
  inputSchema: z.object({ taskId: z.string().min(1) }),
  approval: { mode: 'required', remember: true },
  execute: async ({ taskId }, ctx) => {
    const [task] = await ctx.runtime.db
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, ctx.userId)))
      .returning()
    if (!task) throw new Error('Task not found')
    await ctx.runtime.realtime.publish(tasks, 'delete', task)
    return task
  },
})

const remember = defineTool({
  id: 'remember',
  version: 1,
  description: 'Store one explicit fact or preference for the current user.',
  inputSchema: z.object({
    key: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(2_000),
  }),
  approval: { mode: 'none' },
  execute: async ({ key, value }, ctx) => {
    const row = await storeMemory(ctx.runtime, {
      userId: ctx.userId,
      kind: 'fact',
      key,
      value,
      source: {
        type: ctx.trigger.type,
        trusted: ctx.trigger.trusted,
        id: ctx.trigger.sourceId,
      },
    })
    return { key: row.key, value: row.value }
  },
})

export const agentDefinition = defineAgent({
  instructions: ({ now }) =>
    [
      'You are a concise personal task agent.',
      `Current time is ${now.toISOString()}.`,
      'Use tools for every read or mutation; never claim an effect you did not perform.',
    ].join('\n'),
  tools: {
    listTasks,
    createTask,
    completeTask,
    scheduleReminder,
    deleteTask,
    remember,
  },
  events: {
    'task.reminder_due': { delivery: 'immediate', aggregate: 'latest' },
    'subscription.limit_near': {
      delivery: 'next_turn',
      aggregate: 'latest',
    },
    'activity.digest': { delivery: 'next_turn', aggregate: 'collect' },
    'notification.count': { delivery: 'next_turn', aggregate: 'count' },
    'audit.silent': { delivery: 'silent', aggregate: 'collect' },
  },
  context: {
    conversation: { recent: 20 },
    inbox: { maxItems: 10 },
    memory: { maxItems: 8 },
  },
})
