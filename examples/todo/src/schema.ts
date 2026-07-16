import { typeid, generateTypeId } from 'bunderstack'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export * from 'bunderstack/schema'

// ── Auth tables ──────────────────────────────────────────────────────────
// The anonymous plugin only ever touches `user` and `session`, so the
// usual `account` and `verification` tables are not needed.
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

// ── Domain tables ────────────────────────────────────────────────────────
// A board is a shared todo list. Its typeid is unguessable, so the board URL
// (/b/$boardId) doubles as the invite: anyone with the link is a member.
export const boards = sqliteTable('boards', {
  id: typeid('board')
    .primaryKey()
    .$defaultFn(() => generateTypeId('board')),
  name: text('name').notNull(),
  ownerId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const todos = sqliteTable('todos', {
  id: typeid('todo')
    .primaryKey()
    .$defaultFn(() => generateTypeId('todo')),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  imageFileId: text('imageFileId'),
  boardId: typeid('board')
    .notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  // Denormalized author label — todos are collaborative, so this is display
  // data, not an ownership column.
  authorName: text('authorName').notNull().default(''),
  completedAt: integer('completedAt', { mode: 'timestamp' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})
