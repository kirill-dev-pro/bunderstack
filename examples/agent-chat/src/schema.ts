import { generateTypeId, typeid } from 'bunderstack'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export * from 'bunderstack/schema'

export const user = sqliteTable('user', {
  id: typeid('user')
    .primaryKey()
    .$defaultFn(() => generateTypeId('user')),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  isAnonymous: integer('isAnonymous', { mode: 'boolean' }),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

export const session = sqliteTable('session', {
  id: typeid('session')
    .primaryKey()
    .$defaultFn(() => generateTypeId('session')),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const agentThreads = sqliteTable('agent_threads', {
  id: typeid('athread')
    .primaryKey()
    .$defaultFn(() => generateTypeId('athread')),
  userId: typeid('user')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['idle', 'running'] })
    .notNull()
    .default('idle'),
  wakeSeq: integer('wake_seq').notNull().default(0),
  lockedAt: integer('locked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const agentMessages = sqliteTable('agent_messages', {
  id: typeid('amsg')
    .primaryKey()
    .$defaultFn(() => generateTypeId('amsg')),
  threadId: typeid('athread')
    .notNull()
    .references(() => agentThreads.id, { onDelete: 'cascade' }),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export type CommitmentSchedule =
  | { kind: 'cron'; expr: string; timezone?: string }
  | { kind: 'interval'; everySeconds: number }

export type CommitmentExecutionSpec =
  | { kind: 'notify'; message: string }
  | {
      kind: 'tool_call'
      tool: 'createTask' | 'completeTask' | 'deleteTask' | 'remember'
      args: Record<string, unknown>
    }
  | { kind: 'objective'; prompt: string }

export const agentCommitments = sqliteTable('agent_commitments', {
  id: typeid('acommit')
    .primaryKey()
    .$defaultFn(() => generateTypeId('acommit')),
  threadId: typeid('athread')
    .notNull()
    .references(() => agentThreads.id, { onDelete: 'cascade' }),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  kind: text('kind', {
    enum: ['reminder', 'notify', 'tool_call', 'objective'],
  }).notNull(),
  title: text('title').notNull(),
  schedule: text('schedule', {
    mode: 'json',
  }).$type<CommitmentSchedule>(),
  executionSpec: text('execution_spec', {
    mode: 'json',
  }).$type<CommitmentExecutionSpec>(),
  dueAt: integer('due_at', { mode: 'timestamp' }).notNull(),
  status: text('status', {
    enum: [
      'pending',
      'blocked',
      'running',
      'waiting_for_approval',
      'completed',
      'failed',
      'cancelled',
      'paused',
      'fired',
    ],
  })
    .notNull()
    .default('pending'),
  currentRunId: typeid('arun'),
  result: text('result', { mode: 'json' }).$type<unknown>(),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  firedAt: integer('fired_at', { mode: 'timestamp' }),
})

export const agentCommitmentDependencies = sqliteTable(
  'agent_commitment_dependencies',
  {
    commitmentId: typeid('acommit')
      .notNull()
      .references(() => agentCommitments.id, { onDelete: 'cascade' }),
    dependsOnCommitmentId: typeid('acommit')
      .notNull()
      .references(() => agentCommitments.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('agent_commitment_dependency_unique').on(
      table.commitmentId,
      table.dependsOnCommitmentId,
    ),
  ],
)

export const agentRuns = sqliteTable('agent_runs', {
  id: typeid('arun')
    .primaryKey()
    .$defaultFn(() => generateTypeId('arun')),
  threadId: typeid('athread')
    .notNull()
    .references(() => agentThreads.id, { onDelete: 'cascade' }),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  commitmentId: typeid('acommit').references(() => agentCommitments.id, {
    onDelete: 'set null',
  }),
  triggerType: text('trigger_type', {
    enum: ['user_message', 'system_event', 'commitment'],
  }),
  reason: text('reason').notNull(),
  status: text('status', {
    enum: ['running', 'waiting_for_approval', 'done', 'failed'],
  }).notNull(),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<{
    messages: Array<Record<string, unknown>>
  }>(),
  error: text('error'),
  startedAt: integer('started_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

export const agentToolCalls = sqliteTable(
  'agent_tool_calls',
  {
    id: typeid('acall')
      .primaryKey()
      .$defaultFn(() => generateTypeId('acall')),
    runId: typeid('arun')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    threadId: typeid('athread')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Legacy demo rows predate execution identities; every new runtime write
    // supplies one, while the nullable column keeps the migration additive.
    executionId: text('execution_id'),
    tool: text('tool').notNull(),
    args: text('args', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('agent_tool_calls_execution_unique').on(table.executionId),
  ],
)

export const tasks = sqliteTable('tasks', {
  id: typeid('task')
    .primaryKey()
    .$defaultFn(() => generateTypeId('task')),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

export const agentMemory = sqliteTable(
  'agent_memory',
  {
    id: typeid('amem')
      .primaryKey()
      .$defaultFn(() => generateTypeId('amem')),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['preference', 'fact', 'summary'] }).notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
    sourceType: text('source_type', {
      enum: ['user', 'system', 'derived'],
    }).notNull(),
    sourceId: text('source_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('agent_memory_user_key_unique').on(table.userId, table.key),
  ],
)

export const agentInbox = sqliteTable(
  'agent_inbox',
  {
    id: typeid('ainbox')
      .primaryKey()
      .$defaultFn(() => generateTypeId('ainbox')),
    threadId: typeid('athread')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    delivery: text('delivery', {
      enum: ['immediate', 'next_turn', 'silent'],
    }).notNull(),
    aggregate: text('aggregate', {
      enum: ['latest', 'collect', 'count'],
    }).notNull(),
    dedupeKey: text('dedupe_key'),
    status: text('status', { enum: ['pending', 'consumed', 'expired'] })
      .notNull()
      .default('pending'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    consumedAt: integer('consumed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('agent_inbox_pending').on(
      table.userId,
      table.threadId,
      table.status,
      table.createdAt,
    ),
    uniqueIndex('agent_inbox_pending_dedupe').on(
      table.userId,
      table.threadId,
      table.dedupeKey,
      table.status,
    ),
  ],
)

export const agentRequests = sqliteTable(
  'agent_requests',
  {
    id: typeid('arequest')
      .primaryKey()
      .$defaultFn(() => generateTypeId('arequest')),
    threadId: typeid('athread')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    runId: typeid('arun')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['input', 'approval'] }).notNull(),
    status: text('status', {
      enum: ['pending', 'answered', 'approved', 'rejected', 'expired'],
    })
      .notNull()
      .default('pending'),
    prompt: text('prompt').notNull(),
    tool: text('tool'),
    toolVersion: integer('tool_version'),
    args: text('args', { mode: 'json' }).$type<Record<string, unknown>>(),
    approvalId: text('approval_id'),
    toolCallId: text('tool_call_id'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('agent_requests_pending').on(
      table.userId,
      table.threadId,
      table.status,
      table.createdAt,
    ),
  ],
)

export const agentToolGrants = sqliteTable(
  'agent_tool_grants',
  {
    id: typeid('agrant')
      .primaryKey()
      .$defaultFn(() => generateTypeId('agrant')),
    threadId: typeid('athread')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    toolVersion: integer('tool_version').notNull(),
    scope: text('scope', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text('status', { enum: ['active', 'revoked', 'expired'] })
      .notNull()
      .default('active'),
    grantedAt: integer('granted_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('agent_tool_grants_active').on(
      table.userId,
      table.threadId,
      table.tool,
      table.toolVersion,
      table.status,
    ),
  ],
)
