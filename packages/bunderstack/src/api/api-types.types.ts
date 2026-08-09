import { pgTable, text } from 'drizzle-orm/pg-core'
import { z } from 'zod'
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

const app = await createBunderstack({
  schema: { posts },
  database: { adapter: pglite() },
  processEnv: {
    DATABASE_URL: 'file:./api-types.pglite',
    BUNDERSTACK_ROLE: 'web',
  },
  access: { posts: { crud: true, list: 'public' } },
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

type ApiCarrier = NonNullable<typeof app.$inferClient>['api']
type _ApiWasCaptured = Expect<Equal<'stats' extends keyof ApiCarrier ? true : false, true>>
