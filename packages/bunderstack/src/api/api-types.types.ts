import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { InferRouterInputs, InferRouterOutputs } from '@orpc/server'
import { createBunderstack } from '../index'
import { pglite } from '../database/pglite'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const privateNotes = pgTable('private_notes', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
})

const typedApp = await createBunderstack({
  schema: { posts, privateNotes },
  database: { adapter: pglite() },
  processEnv: {
    DATABASE_URL: 'file:./crud-api-types.pglite',
    BUNDERSTACK_ROLE: 'web',
  },
  access: {
    posts: { crud: true, list: 'public', create: 'public' },
    privateNotes: { crud: false },
  },
  api: (o) => ({
    stats: o.protected
      .input(z.object({ period: z.enum(['day', 'week']) }))
      .output(z.object({ period: z.enum(['day', 'week']), userId: z.string() }))
      .handler(async ({ input, context }) => {
        const _userId: string = context.user.id
        const _db = context.db
        const _env = context.env
        return {
          period: input.period,
          userId: context.user.id,
        }
      }),
  }),
})

type Api = NonNullable<typeof typedApp.$inferClient>['api']

type _HasPosts = Expect<Equal<'posts' extends keyof Api ? true : false, true>>
type _HidesPrivateNotes = Expect<Equal<'privateNotes' extends keyof Api ? true : false, false>>
type _HasStats = Expect<Equal<'stats' extends keyof Api ? true : false, true>>

type PostsInputs = InferRouterInputs<Api>['posts']
type PostsOutputs = InferRouterOutputs<Api>['posts']

type _CreateInput = Expect<Equal<PostsInputs['create'], typeof posts.$inferInsert>>
type _GetInput = Expect<Equal<PostsInputs['get'], { id: string }>>
type _UpdateInput = Expect<Equal<PostsInputs['update'], { id: string; title?: string }>>
type _ListItems = Expect<Equal<PostsOutputs['list']['items'], Array<{ id: string; title: string }>>>
