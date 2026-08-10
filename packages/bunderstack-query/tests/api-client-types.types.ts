import { openapi } from '@orpc/openapi'
import { z } from 'zod'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { createBunderstack } from 'bunderstack'
import { pglite } from 'bunderstack/database/pglite'
import { createClient } from '../src/index'

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
    processEnv: { DATABASE_URL: 'file:./test-api-client-types.pglite', BUNDERSTACK_ROLE: 'web' },
    access: {
      posts: { crud: true, list: 'public', get: 'public' },
      privateNotes: { crud: false },
    },
    api: (o) => ({
      stats: {
        get: o.public
          .meta(openapi({ method: 'GET', path: '/api/stats' }))
          .input(z.object({ id: z.string() }))
          .handler(async ({ input }) => ({ id: input.id, totalPosts: 42 })),
      },
    }),
  })
}

async function testTypes() {
  const app = await setupApp()
  const client = createClient<typeof app>({
    baseUrl: 'http://localhost/api',
    fetch: app.handler,
  })

  const queryContext = { signal: new AbortController().signal } as any

  client.api.stats.get.queryOptions({ input: { id: 'ok' } })

  // @ts-expect-error id is required
  client.api.stats.get.queryOptions({ input: {} })

  // @ts-expect-error totalPosts is a number
  const wrongOutput: string = await client.api.stats.get.queryOptions({
    input: { id: 'ok' },
  }).queryFn(queryContext)

  // @ts-expect-error route does not exist
  client.api.missing.get.queryOptions({ input: {} })

  // @ts-expect-error disabled CRUD table is not exposed
  client.api.privateNotes.list.queryOptions({ input: {} })
}
