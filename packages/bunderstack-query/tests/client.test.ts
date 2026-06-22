import { test, expect } from 'bun:test'
import { sqliteTable, integer, text } from 'bunderstack'

import {
  createBunderstackQueryClient,
  BunderstackApiError,
} from '../src/index.ts'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  userId: text('userId').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
})

const schema = { posts }

const mockPosts = [
  {
    id: 1,
    title: 'First',
    body: 'Hello',
    userId: 'u1',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    title: 'Second',
    body: 'World',
    userId: 'u2',
    createdAt: '2026-01-02T00:00:00.000Z',
  },
]

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init?: RequestInit) =>
    handler(url, init)) as typeof fetch
}

test('withSchema exposes tables', () => {
  const client = createBunderstackQueryClient().withSchema({ schema })
  expect(client.posts).toBeDefined()
  expect(client.posts.keys.all).toEqual(['posts'])
})

test('withTables exposes tables by name', () => {
  type Schema = { posts: typeof posts }
  const client = createBunderstackQueryClient<Schema>().withTables({
    tables: ['posts'] as const,
  })
  expect(client.posts).toBeDefined()
  expect(client.posts.keys.all).toEqual(['posts'])
})

test('list fetches paginated results', async () => {
  const client = createBunderstackQueryClient().withSchema({
    schema,
    fetch: mockFetch((url) => {
      expect(url).toBe('/api/posts?limit=2&offset=0')
      return Response.json({
        items: mockPosts.slice(0, 2),
        limit: 2,
        offset: 0,
      })
    }),
  })

  const result = await client.posts.list({ limit: 2, offset: 0 })
  expect(result.items).toHaveLength(2)
  expect(result.limit).toBe(2)
})

test('create sends POST with credentials', async () => {
  const client = createBunderstackQueryClient().withSchema({
    schema,
    fetch: mockFetch((url, init) => {
      expect(url).toBe('/api/posts')
      expect(init?.method).toBe('POST')
      expect(init?.credentials).toBe('include')
      expect(JSON.parse(init?.body as string)).toEqual({ title: 'New post' })
      return Response.json(
        { ...mockPosts[0], title: 'New post' },
        { status: 201 },
      )
    }),
  })

  const post = await client.posts.create({ title: 'New post' })
  expect(post.title).toBe('New post')
})

test('update sends PATCH', async () => {
  const client = createBunderstackQueryClient().withSchema({
    schema,
    fetch: mockFetch((url, init) => {
      expect(url).toBe('/api/posts/1')
      expect(init?.method).toBe('PATCH')
      return Response.json({ ...mockPosts[0], title: 'Updated' })
    }),
  })

  const post = await client.posts.update(1, { title: 'Updated' })
  expect(post.title).toBe('Updated')
})

test('delete sends DELETE and handles 204', async () => {
  const client = createBunderstackQueryClient().withSchema({
    schema,
    fetch: mockFetch((url, init) => {
      expect(url).toBe('/api/posts/1')
      expect(init?.method).toBe('DELETE')
      return new Response(null, { status: 204 })
    }),
  })

  await client.posts.delete(1)
})

test('throws BunderstackApiError on failure', async () => {
  const client = createBunderstackQueryClient().withSchema({
    schema,
    fetch: mockFetch(() =>
      Response.json({ error: 'Forbidden' }, { status: 403 }),
    ),
  })

  try {
    await client.posts.delete(99)
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(BunderstackApiError)
    expect((err as BunderstackApiError).status).toBe(403)
    expect((err as BunderstackApiError).message).toBe('Forbidden')
  }
})

test('query keys are stable', () => {
  const client = createBunderstackQueryClient().withSchema({ schema })
  const keys = client.posts.keys
  expect(keys.list({ limit: 10, offset: 0 })).toEqual([
    'posts',
    'list',
    { limit: 10, offset: 0 },
  ])
  expect(keys.detail(42)).toEqual(['posts', 'detail', 42])
})

test('listQuery matches list query key', () => {
  const client = createBunderstackQueryClient().withSchema({ schema })
  const params = { limit: 5, offset: 10 }
  expect(client.posts.listQuery(params).queryKey).toEqual(
    client.posts.keys.list(params),
  )
})

test('getQuery matches detail query key', () => {
  const client = createBunderstackQueryClient().withSchema({ schema })
  expect(client.posts.getQuery(42).queryKey).toEqual(
    client.posts.keys.detail(42),
  )
})
