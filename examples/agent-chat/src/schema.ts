import { generateTypeId, typeid } from 'bunderstack'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
  reason: text('reason').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  error: text('error'),
  startedAt: integer('started_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

export const agentToolCalls = sqliteTable('agent_tool_calls', {
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
  tool: text('tool').notNull(),
  args: text('args', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  result: text('result', { mode: 'json' }).$type<unknown>(),
  status: text('status', { enum: ['done', 'failed'] }).notNull(),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

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
  kind: text('kind', { enum: ['reminder'] }).notNull(),
  title: text('title').notNull(),
  dueAt: integer('due_at', { mode: 'timestamp' }).notNull(),
  status: text('status', { enum: ['pending', 'fired', 'cancelled'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  firedAt: integer('fired_at', { mode: 'timestamp' }),
})

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
