import { describe, it, expect } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createBunderstack, MAX_LIST_LIMIT } from './index'
import { defineAccess } from './access'

// -- type-level assertion helpers -------------------------------------------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
type Expect<T extends true> = T

const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})
const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})
const schema = { user, posts }

describe('client type inference carriers', () => {
  it('exports MAX_LIST_LIMIT = 200', () => {
    expect(MAX_LIST_LIMIT).toBe(200)
  })

  it('defineAccess preserves literal rule types', () => {
    const access = defineAccess(schema, {
      user: { exposeAuthTable: true, ownerColumn: 'id' },
      posts: { ownerColumn: 'userId' },
    })
    type _1 = Expect<Equal<(typeof access)['user']['exposeAuthTable'], true>>
    expect(access.posts.ownerColumn).toBe('userId')
  })

  it('createBunderstack carries schema/access/buckets in $inferClient', async () => {
    const app = await createBunderstack({
      schema,
      access: {
        user: { exposeAuthTable: true, ownerColumn: 'id' },
        posts: { ownerColumn: 'userId' },
      },
      database: { url: ':memory:' },
      storage: {
        local: './uploads',
        defaultBucket: 'images',
        buckets: { images: {}, docs: {} },
      },
    })
    type Carrier = NonNullable<(typeof app)['$inferClient']>
    type _schema = Expect<Equal<Carrier['schema'], typeof schema>>
    type _buckets = Expect<Equal<Carrier['buckets'], 'images' | 'docs'>>
    type _accessUser = Expect<
      Equal<Carrier['access']['user']['exposeAuthTable'], true>
    >
    // runtime: phantom prop is never assigned
    expect('$inferClient' in app).toBe(false)
  })
})
