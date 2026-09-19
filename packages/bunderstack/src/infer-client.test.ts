import { describe, it, expect } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { defineAccess, defineSessionUser } from './access'
import { libsql } from './database/libsql'
import { bunderstack, MAX_LIST_LIMIT } from './index'

// -- type-level assertion helpers -------------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
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
    void (0 as unknown as Expect<
      Equal<(typeof access)['user']['exposeAuthTable'], true>
    >)
    expect(access.posts.ownerColumn).toBe('userId')
  })

  it('bunderstack carries schema/access/buckets in $inferClient', async () => {
    const app = await bunderstack({
      schema,
      access: {
        user: { exposeAuthTable: true, ownerColumn: 'id' },
        posts: { ownerColumn: 'userId' },
      },
      database: { url: ':memory:', adapter: libsql() },
      storage: {
        local: './uploads',
        defaultBucket: 'images',
        buckets: { images: {}, docs: {} },
      },
      api: (o) => ({
        stats: o.public.input(v.object({})).handler(async () => ({ posts: 1 })),
      }),
      jobs: (j) =>
        j.define({
          sendPost: j.job({ handler: async () => {} }),
          hourly: j.cron({
            schedule: '0 * * * *',
            handler: async () => {},
          }),
        }),
      realtime: true,
    }).start()
    type Carrier = NonNullable<(typeof app)['$inferClient']>
    void (0 as unknown as Expect<Equal<Carrier['schema'], typeof schema>>)
    void (0 as unknown as Expect<Equal<Carrier['buckets'], 'images' | 'docs'>>)
    void (0 as unknown as Expect<
      Equal<Carrier['access']['user']['exposeAuthTable'], true>
    >)
    void (0 as unknown as Expect<
      Equal<'stats' extends keyof Carrier['api'] ? true : false, true>
    >)
    void (0 as unknown as Expect<
      Equal<'live' extends keyof Carrier['api']['posts'] ? true : false, true>
    >)
    // @ts-expect-error the old runtime router is intentionally not exposed
    void app.router
    // @ts-expect-error the old tRPC router is intentionally not exposed
    void app.trpcRouter
    // @ts-expect-error cron declarations cannot be enqueued
    const cronEnqueue = () => app.jobs.enqueue('hourly')
    void cronEnqueue
    // runtime: phantom prop is never assigned
    expect('$inferClient' in app).toBe(false)
  })

  it('rejects removed split transport config', () => {
    const database = { url: ':memory:', adapter: libsql() }
    void bunderstack({
      schema,
      database,
      // @ts-expect-error `routes` was replaced by the one API graph
      routes: () => ({}),
    }).start()
    void bunderstack({
      schema,
      database,
      // @ts-expect-error `trpc` was replaced by the one API graph
      trpc: () => ({}),
    }).start()
    expect(true).toBe(true)
  })

  it('infers mapped session fields in an inline API builder', () => {
    const session = defineSessionUser({
      mapUser(user) {
        return { clinicId: String(user.clinicId) }
      },
    })

    const backend = bunderstack({
      schema,
      database: { url: ':memory:', adapter: libsql() },
      session,
      api: (o) => ({
        viewer: o.public.handler(async ({ context }) => {
          const resolved = await context.getSession()
          const clinicId: string | undefined = resolved.user?.clinicId
          return { clinicId }
        }),
      }),
    })

    expect(backend.inspect().api.operations).toHaveLength(1)
  })
})
