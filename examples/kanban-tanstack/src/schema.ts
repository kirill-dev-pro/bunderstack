import { generateTypeId, typeid } from 'bunderstack'
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export * from 'bunderstack/schema'

// --- BetterAuth core ---
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
})
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// --- BetterAuth organization plugin ---
export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
export const invitation = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

// --- App tables (typeid + denormalized organizationId) ---
export const boards = sqliteTable('boards', {
  id: typeid('board')
    .primaryKey()
    .$defaultFn(() => generateTypeId('board')),
  organizationId: text('organization_id').notNull(),
  title: text('title').notNull(),
  background: text('background').default('blue'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const lists = sqliteTable('lists', {
  id: typeid('list')
    .primaryKey()
    .$defaultFn(() => generateTypeId('list')),
  organizationId: text('organization_id').notNull(),
  boardId: typeid('board')
    .notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  position: real('position').notNull().default(1000),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const cards = sqliteTable('cards', {
  id: typeid('card')
    .primaryKey()
    .$defaultFn(() => generateTypeId('card')),
  organizationId: text('organization_id').notNull(),
  boardId: typeid('board')
    .notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  listId: typeid('list')
    .notNull()
    .references(() => lists.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  assigneeId: typeid('user').references(() => user.id),
  position: real('position').notNull().default(1000),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const comments = sqliteTable('comments', {
  id: typeid('cmt')
    .primaryKey()
    .$defaultFn(() => generateTypeId('cmt')),
  organizationId: text('organization_id').notNull(),
  cardId: typeid('card')
    .notNull()
    .references(() => cards.id, { onDelete: 'cascade' }),
  authorId: typeid('user').references(() => user.id),
  body: text('body').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const activity = sqliteTable('activity', {
  id: typeid('act')
    .primaryKey()
    .$defaultFn(() => generateTypeId('act')),
  organizationId: text('organization_id').notNull(),
  boardId: typeid('board')
    .notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  cardId: typeid('card').references(() => cards.id, { onDelete: 'cascade' }),
  actorId: typeid('user').references(() => user.id),
  type: text('type').notNull(),
  data: text('data', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const attachments = sqliteTable('attachments', {
  id: typeid('att')
    .primaryKey()
    .$defaultFn(() => generateTypeId('att')),
  organizationId: text('organization_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  uploaderId: typeid('user').references(() => user.id),
  fileUrl: text('file_url').notNull(),
  fileName: text('file_name'),
  mimeType: text('mime_type'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
export const reactions = sqliteTable('reactions', {
  id: typeid('rxn')
    .primaryKey()
    .$defaultFn(() => generateTypeId('rxn')),
  organizationId: text('organization_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  userId: typeid('user')
    .notNull()
    .references(() => user.id),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
})
