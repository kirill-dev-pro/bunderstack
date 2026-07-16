import { typeid, generateTypeId } from 'bunderstack'
import {
  sqliteTable,
  integer,
  text,
  foreignKey,
} from 'drizzle-orm/sqlite-core'

export * from 'bunderstack/schema'

// BetterAuth required tables
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
  about: text('about').default(''),
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

export const account = sqliteTable('account', {
  id: typeid('account')
    .primaryKey()
    .$defaultFn(() => generateTypeId('account')),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: typeid('verification')
    .primaryKey()
    .$defaultFn(() => generateTypeId('verification')),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }),
})

export const posts = sqliteTable(
  'posts',
  {
    id: typeid('post')
      .primaryKey()
      .$defaultFn(() => generateTypeId('post')),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    imageUrl: text('imageUrl'),
    userId: typeid('user')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    replyToId: typeid('post'),
    createdAt: integer('createdAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    foreignKey({
      columns: [table.replyToId],
      foreignColumns: [table.id],
    }).onDelete('cascade'),
  ],
)

export const follows = sqliteTable('follows', {
  id: typeid('follow')
    .primaryKey()
    .$defaultFn(() => generateTypeId('follow')),
  followerId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  followingId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const likes = sqliteTable('likes', {
  id: typeid('like')
    .primaryKey()
    .$defaultFn(() => generateTypeId('like')),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  postId: typeid('post')
    .notNull()
    .references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const retweets = sqliteTable('retweets', {
  id: typeid('retweet')
    .primaryKey()
    .$defaultFn(() => generateTypeId('retweet')),
  userId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  postId: typeid('post')
    .notNull()
    .references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})
