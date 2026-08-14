import { test, expect } from 'bun:test'
import { createBunderstack } from 'bunderstack'
import { pglite } from 'bunderstack/database/pglite'
import { pgTable, text } from 'drizzle-orm/pg-core'
import * as v from 'valibot'

import { createClient } from '../src/index'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const schema = { posts }

async function setupApp() {
  return await createBunderstack({
    schema,
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
    access: {
      posts: { crud: true, list: 'public', get: 'public' },
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

test('createClient provides unified orpc api queryOptions for CRUD and custom procedures', async () => {
  const app = await setupApp()

  const client = createClient<typeof app>({
    baseUrl: 'http://localhost/api',
    fetch: (input, init) => app.handler(new Request(input, init)),
  })

  // CRUD procedure queryOptions
  const listOpts = client.posts.list.queryOptions({ input: {} })
  expect(listOpts.queryKey).toBeDefined()
  expect(listOpts.queryFn).toBeDefined()

  // Custom procedure queryOptions
  const statsOpts = client.stats.get.queryOptions({ input: { id: 'stat_1' } })
  expect(statsOpts.queryKey).toBeDefined()
  expect(statsOpts.queryFn).toBeDefined()
  expect(client.posts.create.mutationOptions().mutationFn).toBeDefined()

  // Execute queryFn with TanStack Query context
  const queryContext = { signal: new AbortController().signal } as any
  const statsResult = await statsOpts.queryFn(queryContext)
  expect(statsResult).toEqual({ id: 'stat_1', totalPosts: 42 })
  expect(await client.stats.get.call({ id: 'stat_2' })).toEqual({
    id: 'stat_2',
    totalPosts: 42,
  })

  await app.close()
})

test('file URL helper is attached to the typed bucket namespace', async () => {
  const app = await createBunderstack({
    schema,
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
    storage: { buckets: { images: {} } },
  })
  const client = createClient<typeof app>({ baseUrl: 'http://localhost/api' })
  expect(client.files.images.url('images/a.b', { w: 100 })).toBe(
    'http://localhost/api/files/images/a%2Eb?w=100',
  )
  await app.close()
})
