import type { InferRouterInputs, InferRouterOutputs } from '@orpc/server'

import { pgTable, text } from 'drizzle-orm/pg-core'
import * as v from 'valibot'

import type { ExposedApiTables } from './types'

import { pglite } from '../database/pglite'
import { createBunderstack } from '../index'

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

const ownedPosts = pgTable('owned_posts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
})

type ImplicitTables = ExposedApiTables<
  { posts: typeof posts; ownedPosts: typeof ownedPosts },
  undefined
>
type _ImplicitAccessHidesUnownedTable = Expect<
  Equal<'posts' extends ImplicitTables ? true : false, false>
>
type _ImplicitAccessIncludesConventionTable = Expect<
  Equal<'ownedPosts' extends ImplicitTables ? true : false, true>
>

const typedApp = await createBunderstack({
  schema: { posts, privateNotes },
  database: { adapter: pglite() },
  processEnv: {
    DATABASE_URL: 'memory://',
    BUNDERSTACK_ROLE: 'web',
  },
  access: {
    posts: { crud: true, list: 'public', create: 'public' },
    privateNotes: { crud: false },
  },
  api: (o) => ({
    stats: o.protected
      .input(v.object({ period: v.picklist(['day', 'week']) }))
      .output(
        v.object({ period: v.picklist(['day', 'week']), userId: v.string() }),
      )
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
type _HidesPrivateNotes = Expect<
  Equal<'privateNotes' extends keyof Api ? true : false, false>
>
type _HasStats = Expect<Equal<'stats' extends keyof Api ? true : false, true>>

type PostsInputs = InferRouterInputs<Api>['posts']
type PostsOutputs = InferRouterOutputs<Api>['posts']
type IsAny<T> = 0 extends 1 & T ? true : false
type ExpectedUpdateInput = {
  params: { id: string }
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  body: { title?: string }
}

type _CreateInput = Expect<
  Equal<
    PostsInputs['create'],
    Partial<typeof posts.$inferInsert>
  >
>
type _GetInput = Expect<Equal<PostsInputs['get'], { id: string }>>
type _UpdateInputToExpected = Expect<
  PostsInputs['update'] extends ExpectedUpdateInput ? true : false
>
type _ExpectedToUpdateInput = Expect<
  ExpectedUpdateInput extends PostsInputs['update'] ? true : false
>
type _ListItems = Expect<
  Equal<PostsOutputs['list']['items'], Array<{ id: string; title: string }>>
>
type _GetOutputIsTyped = Expect<Equal<IsAny<PostsOutputs['get']>, false>>
