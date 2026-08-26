import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { tasks } from '../schema'
import {
  cancelCommitment as cancelStoredCommitment,
  createCommitment as createStoredCommitment,
  listCommitments as listStoredCommitments,
  pauseCommitment as pauseStoredCommitment,
  resumeCommitment as resumeStoredCommitment,
  retryCommitment as retryStoredCommitment,
} from './commitments'
import { defineAgent, defineTool } from './declaration'
import { remember as storeMemory } from './memory'

const listTasks = defineTool({
  id: 'listTasks',
  version: 1,
  description:
    'List all tasks owned by the current user. Inspect open and completed items to plan or execute work.',
  inputSchema: z.object({}),
  approval: { mode: 'none' },
  execute: async (_input, ctx) =>
    ctx.runtime.db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, ctx.userId))
      .all(),
})

const createTask = defineTool({
  id: 'createTask',
  version: 1,
  description: 'Create a new task for the current user.',
  inputSchema: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .describe('Title or description of the task'),
  }),
  approval: { mode: 'none' },
  execute: async ({ title }, ctx) => {
    const [task] = await ctx.runtime.db
      .insert(tasks)
      .values({ userId: ctx.userId, title })
      .returning()
    if (!task) throw new Error('Could not create task')
    await ctx.runtime.realtime.publish(tasks, 'create', task)
    return task
  },
})

const completeTask = defineTool({
  id: 'completeTask',
  version: 1,
  description:
    'Mark one task owned by the current user as completed by its taskId.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to complete'),
  }),
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

const commitmentScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    expr: z
      .string()
      .trim()
      .min(1)
      .describe('5-field cron expression, e.g. "0 9 * * *"'),
    timezone: z.string().optional(),
  }),
  z.object({
    kind: z.literal('interval'),
    everySeconds: z
      .number()
      .int()
      .min(1)
      .describe('Interval step in seconds, e.g. 3600 for 1 hour'),
  }),
])

const commitmentExecutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), message: z.string().trim().min(1) }),
  z.object({
    kind: z.literal('tool_call'),
    tool: z.enum(['createTask', 'completeTask', 'deleteTask', 'remember']),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('objective'), prompt: z.string().trim().min(1) }),
])

const createCommitment = defineTool({
  id: 'createCommitment',
  version: 1,
  description:
    'Persist future or recurring work. Use notify for a user notification, tool_call for an exact future application action, and objective only for genuinely multi-step agent work.',
  inputSchema: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .describe('Short human-readable summary of the commitment'),
    dueAt: z
      .string()
      .trim()
      .min(1)
      .describe(
        'ISO 8601 date with explicit Z or UTC offset (e.g. 2026-08-26T18:00:00.000Z). Optional if schedule is provided.',
      )
      .optional(),
    schedule: commitmentScheduleSchema
      .optional()
      .describe(
        'Optional recurring schedule (cron or interval) for recurring work',
      ),
    execution: commitmentExecutionSchema,
    dependsOn: z.array(z.string().min(1)).optional(),
  }),
  approval: { mode: 'none' },
  execute: async (input, ctx) =>
    createStoredCommitment(ctx.runtime, {
      ...input,
      threadId: ctx.threadId,
      userId: ctx.userId,
    }),
})

const listCommitments = defineTool({
  id: 'listCommitments',
  version: 1,
  description:
    'List persisted commitments and their real execution status for the current agent.',
  inputSchema: z.object({
    status: z
      .enum([
        'pending',
        'blocked',
        'running',
        'waiting_for_approval',
        'completed',
        'failed',
        'cancelled',
        'paused',
      ])
      .optional(),
  }),
  approval: { mode: 'none' },
  execute: async ({ status }, ctx) =>
    listStoredCommitments(ctx.runtime, {
      threadId: ctx.threadId,
      userId: ctx.userId,
      status,
    }),
})

const cancelCommitment = defineTool({
  id: 'cancelCommitment',
  version: 1,
  description:
    'Cancel one pending, paused, or dependency-blocked commitment owned by the current user.',
  inputSchema: z.object({ commitmentId: z.string().min(1) }),
  approval: { mode: 'none' },
  execute: async ({ commitmentId }, ctx) =>
    cancelStoredCommitment(ctx.runtime, {
      commitmentId,
      userId: ctx.userId,
    }),
})

const pauseCommitment = defineTool({
  id: 'pauseCommitment',
  version: 1,
  description:
    'Pause one active recurring commitment owned by the current user.',
  inputSchema: z.object({ commitmentId: z.string().min(1) }),
  approval: { mode: 'none' },
  execute: async ({ commitmentId }, ctx) =>
    pauseStoredCommitment(ctx.runtime, {
      commitmentId,
      userId: ctx.userId,
    }),
})

const resumeCommitment = defineTool({
  id: 'resumeCommitment',
  version: 1,
  description:
    'Resume one paused recurring commitment owned by the current user.',
  inputSchema: z.object({ commitmentId: z.string().min(1) }),
  approval: { mode: 'none' },
  execute: async ({ commitmentId }, ctx) =>
    resumeStoredCommitment(ctx.runtime, {
      commitmentId,
      userId: ctx.userId,
    }),
})

const retryCommitment = defineTool({
  id: 'retryCommitment',
  version: 1,
  description:
    'Retry one failed commitment while preserving its previous execution attempts.',
  inputSchema: z.object({ commitmentId: z.string().min(1) }),
  approval: { mode: 'none' },
  execute: async ({ commitmentId }, ctx) =>
    retryStoredCommitment(ctx.runtime, {
      commitmentId,
      userId: ctx.userId,
    }),
})

const deleteTask = defineTool({
  id: 'deleteTask',
  version: 1,
  description:
    'Delete one task owned by the current user by its taskId. Requires user approval.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to delete'),
  }),
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
  description:
    'Store one explicit fact, preference, or persistent note for the current user in long-term memory.',
  inputSchema: z.object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe(
        'Identifier key for this memory entry (e.g. preferred_flight_time)',
      ),
    value: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe('The memory value or fact to remember'),
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
      'You are an autonomous and concise personal task agent.',
      `Current time is ${now.toISOString()}.`,
      'The declared tools are your complete interface to application state. Use them for every read or mutation; never claim an effect you did not perform.',
      'When a user names a task but a mutation requires taskId, call listTasks first and use the exact returned ID.',
      'A tool approval suspends this run. Do not continue or repeat the call; the runtime will resume you with the approval decision and tool result.',
      'Do not claim that an action completed until its tool result confirms success.',
      'Use createCommitment for future or recurring work: choose tool_call for exact application actions, notify for notifications, and objective only for multi-step reasoning.',
      'Use listCommitments to inspect real commitment state; never infer it from earlier assistant text.',
    ].join('\n'),
  tools: {
    listTasks,
    createTask,
    completeTask,
    createCommitment,
    listCommitments,
    cancelCommitment,
    pauseCommitment,
    resumeCommitment,
    retryCommitment,
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
