import { describe, it, expect } from 'bun:test'
import { MAX_LIST_LIMIT as SERVER_MAX_LIST_LIMIT } from 'bunderstack'

import { createClient, MAX_LIST_LIMIT } from '../src/index'
import type { ExposedTables } from '../src/infer'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
type Expect<T extends true> = T

// Minimal fake app type — mirrors what createBunderstack produces.
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

describe('ExposedTables', () => {
  it('derives exposure from access + convention', () => {
    type Exposed = ExposedTables<FakeSchema, FakeAccess>
    // user via exposeAuthTable, posts explicit; secrets crud:false out;
    // session is an auth table (never exposed by convention).
    type _1 = Expect<Equal<Exposed, 'user' | 'posts'>>
    expect(true).toBe(true)
  })

  it('exposes convention (userId) tables without an access entry', () => {
    type Schema = {
      comments: Row<{ id: string; body: string; userId: string }>
      settings: Row<{ id: string; theme: string }>
    }
    type Exposed = ExposedTables<Schema, { settings: { crud: true } }>
    type _1 = Expect<Equal<Exposed, 'comments' | 'settings'>>
    expect(true).toBe(true)
  })
})

describe('createClient', () => {
  const fetchMock = (async () =>
    Response.json({ items: [], limit: 20, hasMore: false })) as unknown as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>

  it('materializes table clients lazily and caches them', async () => {
    const api = createClient<FakeApp>({ fetch: fetchMock })
    const first = api.posts
    expect(typeof first.list).toBe('function')
    expect(api.posts).toBe(first) // stable identity
    const page = await api.posts.list()
    expect(page.items).toEqual([])
  })

  it('materializes bucket clients under files.*', () => {
    const api = createClient<FakeApp>({ fetch: fetchMock })
    expect(typeof api.files.images.upload).toBe('function')
    expect(api.files.images).toBe(api.files.images)
  })

  it('is safe against thenable/symbol probing', () => {
    const api = createClient<FakeApp>({ fetch: fetchMock })
    expect((api as Record<string, unknown>).then).toBeUndefined()
    expect(
      (api as unknown as Record<symbol, unknown>)[Symbol.iterator],
    ).toBeUndefined()
  })
})

describe('MAX_LIST_LIMIT', () => {
  it('mirrors the server list cap', () => {
    expect(MAX_LIST_LIMIT).toBe(SERVER_MAX_LIST_LIMIT)
  })
})
