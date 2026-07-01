import {
  sqliteTable,
  integer,
  text,
  typeid,
  generateTypeId,
} from 'bunderstack'

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
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const session = sqliteTable('session', {
  id: typeid('session')
    .primaryKey()
    .$defaultFn(() => generateTypeId('session')),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
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
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const canvas = sqliteTable('canvas', {
  id: typeid('canvas')
    .primaryKey()
    .$defaultFn(() => generateTypeId('canvas')),
  name: text('name').notNull(),

  ownerId: typeid('user')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),

  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const shape = sqliteTable('shape', {
  id: typeid('shape')
    .primaryKey()
    .$defaultFn(() => generateTypeId('shape')),

  canvasId: typeid('canvas')
    .notNull()
    .references(() => canvas.id, { onDelete: 'cascade' }),
  ownerId: typeid('user').references(() => user.id, { onDelete: 'cascade' }),

  type: text('type').notNull(),
  x: integer('x').notNull(),
  y: integer('y').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  rotation: integer('rotation').notNull(),
  color: text('color').notNull(),

  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})
