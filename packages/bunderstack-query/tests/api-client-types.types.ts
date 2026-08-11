import * as v from 'valibot'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { createBunderstack } from 'bunderstack'
import { pglite } from 'bunderstack/database/pglite'
import { createClient, type ClientOptions } from '../src/index'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false

type FetchInput = Parameters<NonNullable<ClientOptions['fetch']>>[0]
type _FetchInputIsTyped = Expect<Equal<IsAny<FetchInput>, false>>
type _FetchReceivesStandardInput = Expect<Equal<FetchInput, RequestInfo | URL>>

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const privateNotes = pgTable('private_notes', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
})

const schema = { posts, privateNotes }

async function setupApp() {
  return await createBunderstack({
    schema,
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
    access: {
      posts: { crud: true, list: 'public', get: 'public' },
      privateNotes: { crud: false },
    },
    api: (o) => ({
      stats: {
        get: o.public
          .route({ method: 'GET', path: '/api/stats' })
          .input(v.object({ id: v.string() }))
          .handler(async ({ input }) => ({ id: input.id, totalPosts: 42 })),
      },
    }),
  })
}

async function testTypes() {
  const app = await setupApp()
  const client = createClient<typeof app>({
    baseUrl: 'http://localhost/api',
    fetch: (input, init) => app.handler(new Request(input, init)),
  })

  const queryContext = { signal: new AbortController().signal } as any

  client.stats.get.queryOptions({ input: { id: 'ok' } })
  client.posts.create.mutationOptions()
  void client.stats.get.call({ id: 'direct' })

  // @ts-expect-error id is required
  client.stats.get.queryOptions({ input: {} })

  // @ts-expect-error totalPosts is a number
  const wrongOutput: string = await client.stats.get.queryOptions({
    input: { id: 'ok' },
  }).queryFn(queryContext)

  // @ts-expect-error route does not exist
  client.missing.get.queryOptions({ input: {} })

  // @ts-expect-error disabled CRUD table is not exposed
  client.privateNotes.list.queryOptions({ input: {} })
}
