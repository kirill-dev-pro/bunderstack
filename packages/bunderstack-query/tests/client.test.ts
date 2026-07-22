import { test, expect } from 'bun:test'
import { MAX_LIST_LIMIT as SERVER_MAX_LIST_LIMIT } from 'bunderstack'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

import type { ExposedTables } from '../src/infer'

import {
  createBunderstackQueryClient,
  createClient,
  MAX_LIST_LIMIT,
  BunderstackApiError,
} from '../src/index'
import { createBunderstackSchemaClient } from '../src/schema'

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
  const client = createBunderstackSchemaClient().withSchema({ schema })
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
  const client = createBunderstackSchemaClient().withSchema({
    schema,
    fetch: mockFetch((url) => {
      expect(url).toBe('/api/posts?limit=2&offset=0')
      return Response.json({
        items: mockPosts.slice(0, 2),
        limit: 2,
        offset: 0,
        hasMore: true,
      })
    }),
  })

  const result = await client.posts.list({ limit: 2, offset: 0 })
  expect(result.items).toHaveLength(2)
  expect(result.limit).toBe(2)
  expect(result.hasMore).toBe(true)
})

test('list builds filter, sort, and count query params', async () => {
  const client = createBunderstackSchemaClient().withSchema({
    schema,
    fetch: mockFetch((url) => {
      expect(url).toBe(
        '/api/posts?limit=5&offset=0&sort=createdAt&order=asc&count=true&replyToId=5',
      )
      return Response.json({
        items: mockPosts,
        limit: 5,
        offset: 0,
        hasMore: false,
        total: 2,
        sort: 'createdAt',
        order: 'asc',
      })
    }),
  })

  const result = await client.posts.list({
    limit: 5,
    offset: 0,
    sort: 'createdAt',
    order: 'asc',
    count: true,
    replyToId: 5,
  })
  expect(result.total).toBe(2)
})

test('create sends POST with credentials', async () => {
  const client = createBunderstackSchemaClient().withSchema({
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
  const client = createBunderstackSchemaClient().withSchema({
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
  const client = createBunderstackSchemaClient().withSchema({
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
  const client = createBunderstackSchemaClient().withSchema({
    schema,
    fetch: mockFetch(() =>
      Response.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    ),
  })

  try {
    await client.posts.delete(99)
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(BunderstackApiError)
    expect((err as BunderstackApiError).status).toBe(403)
    expect((err as BunderstackApiError).message).toBe('Forbidden')
    expect((err as BunderstackApiError).code).toBe('FORBIDDEN')
  }
})

test('query keys are stable', () => {
  const client = createBunderstackSchemaClient().withSchema({ schema })
  const keys = client.posts.keys
  expect(keys.list({ limit: 10, offset: 0 })).toEqual([
    'posts',
    'list',
    { limit: 10, offset: 0 },
  ])
  expect(keys.detail(42)).toEqual(['posts', 'detail', 42])
})

test('listQuery matches list query key', () => {
  const client = createBunderstackSchemaClient().withSchema({ schema })
  const params = { limit: 5, offset: 10 }
  expect(client.posts.listQuery(params).queryKey).toEqual(
    client.posts.keys.list(params),
  )
})

test('getQuery matches detail query key', () => {
  const client = createBunderstackSchemaClient().withSchema({ schema })
  expect(client.posts.getQuery(42).queryKey).toEqual(
    client.posts.keys.detail(42),
  )
})

test('listInfiniteQuery uses cursor pagination', async () => {
  let call = 0
  const client = createBunderstackSchemaClient().withSchema({
    schema,
    fetch: mockFetch((url) => {
      call++
      if (call === 1) {
        expect(url).toBe(
          '/api/posts?limit=2&sort=createdAt&order=desc&replyToId=null',
        )
        return Response.json({
          items: [mockPosts[0]],
          limit: 2,
          hasMore: true,
          nextCursor: 'c1',
        })
      }
      expect(url).toContain('cursor=c1')
      expect(url).toContain('replyToId=null')
      expect(url).not.toContain('offset=')
      return Response.json({
        items: [mockPosts[1]],
        limit: 2,
        hasMore: false,
      })
    }),
  })

  const opts = client.posts.listInfiniteQuery({
    limit: 2,
    sort: 'createdAt',
    order: 'desc',
    replyToId: null,
  })
  expect(opts.queryKey).toEqual([
    'posts',
    'list',
    { limit: 2, sort: 'createdAt', order: 'desc', replyToId: null },
    'infinite',
  ])

  const page1 = await opts.queryFn({ pageParam: undefined })
  expect(page1.nextCursor).toBe('c1')
  expect(opts.getNextPageParam(page1)).toBe('c1')

  const page2 = await opts.queryFn({ pageParam: 'c1' })
  expect(page2.items).toHaveLength(1)
  expect(opts.getNextPageParam(page2)).toBeUndefined()
})

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T

type Row<T> = { $inferSelect: T; $inferInsert: Partial<T> }
type FakeSchema = {
  user: Row<{ id: string; name: string }>
  posts: Row<{ id: string; title: string; userId: string }>
  secrets: Row<{ id: string; key: string }>
  session: Row<{ id: string; userId: string }>
}
type FakeAccess = {
  user: { exposeAuthTable: true; ownerColumn: 'id' }
  posts: { ownerColumn: 'userId' }
  secrets: { crud: false }
}
type FakeApp = {
  $inferClient?: { schema: FakeSchema; access: FakeAccess; buckets: 'images' }
}

test('ExposedTables derives exposure from access + convention', () => {
  type Exposed = ExposedTables<FakeSchema, FakeAccess>
  type _1 = Expect<Equal<Exposed, 'user' | 'posts'>>
  expect(true).toBe(true)
})

test('ExposedTables exposes convention (userId) tables without an access entry', () => {
  type Schema = {
    comments: Row<{ id: string; body: string; userId: string }>
    settings: Row<{ id: string; theme: string }>
  }
  type Exposed = ExposedTables<Schema, { settings: { crud: true } }>
  type _1 = Expect<Equal<Exposed, 'comments' | 'settings'>>
  expect(true).toBe(true)
})

test('createClient materializes table clients lazily and caches them', async () => {
  const fetchMock = (async () =>
    Response.json({ items: [], limit: 20, hasMore: false })) as unknown as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>
  const api = createClient<FakeApp>({ fetch: fetchMock })
  const first = api.posts
  expect(typeof first.list).toBe('function')
  expect(api.posts).toBe(first)
  const page = await api.posts.list()
  expect(page.items).toEqual([])
})

test('createClient materializes bucket clients under files.*', () => {
  const fetchMock = (async () => Response.json({})) as any
  const api = createClient<FakeApp>({ fetch: fetchMock })
  expect(typeof api.files.images.upload).toBe('function')
  expect(api.files.images).toBe(api.files.images)
})

test('createClient is safe against thenable/symbol probing', () => {
  const api = createClient<FakeApp>({})
  expect((api as Record<string, unknown>).then).toBeUndefined()
  expect(
    (api as unknown as Record<symbol, unknown>)[Symbol.iterator],
  ).toBeUndefined()
})

test('MAX_LIST_LIMIT mirrors the server list cap', () => {
  expect(MAX_LIST_LIMIT).toBe(SERVER_MAX_LIST_LIMIT)
})
