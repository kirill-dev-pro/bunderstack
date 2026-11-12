import { generateTypeId, typeid } from 'bunderstack'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { user } from './auth'

export const PROJECT_STATUSES = [
  'brief',
  'production',
  'review',
  'ready',
] as const

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const

/**
 * A delivery engagement owned by one user. `ownerId` is stamped server-side and
 * is the column every read and write scope filters on.
 */
export const projects = sqliteTable('projects', {
  id: typeid('project')
    .primaryKey()
    .$defaultFn(() => generateTypeId('project')),
  ownerId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  clientName: text('clientName').notNull().default(''),
  status: text('status', { enum: PROJECT_STATUSES }).notNull().default('brief'),
  dueAt: integer('dueAt', { mode: 'timestamp' }),
  /** A cover image in the public bucket, served by the app at this path. */
  coverUrl: text('coverUrl'),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

/**
 * A unit of work inside a project. `ownerId` is denormalised from the project
 * so list scoping stays a single-column filter rather than a join.
 */
export const tasks = sqliteTable('tasks', {
  id: typeid('task')
    .primaryKey()
    .$defaultFn(() => generateTypeId('task')),
  projectId: typeid('project')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ownerId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  status: text('status', { enum: TASK_STATUSES }).notNull().default('todo'),
  position: integer('position').notNull().default(0),
  completedAt: integer('completedAt', { mode: 'timestamp' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

/**
 * A file uploaded to the private `project-files` bucket and attached to a
 * project. Storage keeps the bytes and who owns them; this row says which
 * project they belong to, so the page can list them.
 */
export const attachments = sqliteTable('attachments', {
  id: typeid('attachment')
    .primaryKey()
    .$defaultFn(() => generateTypeId('attachment')),
  projectId: typeid('project')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ownerId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  fileId: text('fileId').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('contentType').notNull().default(''),
  size: integer('size').notNull().default(0),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})
