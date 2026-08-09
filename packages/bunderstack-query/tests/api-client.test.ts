import { test, expect } from 'bun:test'
import { os } from '@orpc/server'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'
import { createBunderstack } from 'bunderstack'
import { pglite } from 'bunderstack/database/pglite'
import { createClient } from '../src/index'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const schema = { posts }

async function setupApp() {
  const client = new PGlite()
  await client.exec('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL);')

  return await createBunderstack({
    schema,
    database: { adapter: pglite({ client }) },
    processEnv: { DATABASE_URL: 'memory', BUNDERSTACK_ROLE: 'web' },
    access: {
      posts: { crud: true, list: 'public', get: 'public' },
    },
    api: (o) => ({
      stats: {
        get: o.public
          .meta(openapi({ method: 'GET', path: '/api/stats' }))
          .input(z.object({ id: z.string() }))
          .handler(async ({ input }) => ({ id: input.id, totalPosts: 42 })),
      },
    }),
  } as any)
}

test('createClient provides unified orpc api queryOptions for CRUD and custom procedures', async () => {
  const app = await setupApp()

  const client = createClient<typeof app>({
    baseUrl: 'http://localhost/api',
    fetch: app.handler as any,
  })

  // CRUD procedure queryOptions
  const listOpts = (client.api as any).posts.list.queryOptions({ input: {} })
  expect(listOpts.queryKey).toBeDefined()
  expect(listOpts.queryFn).toBeDefined()

  // Custom procedure queryOptions
  const statsOpts = (client.api as any).stats.get.queryOptions({ input: { id: 'stat_1' } })
  expect(statsOpts.queryKey).toBeDefined()
  expect(statsOpts.queryFn).toBeDefined()

  // Execute queryFn with TanStack Query context
  const statsResult = await statsOpts.queryFn({ signal: new AbortController().signal } as any)
  expect(statsResult).toEqual({ id: 'stat_1', totalPosts: 42 })

  await app.close()
})
