import { QueryClient } from '@tanstack/react-query'
import { describe, it, expect } from 'bun:test'

import { createSyncClient } from './sync-client'

type Row<T> = { $inferSelect: T; $inferInsert: Partial<T> }
type FakeApp = {
  $inferClient?: {
    schema: {
      posts: Row<{ id: string; title: string; userId: string }>
      user: Row<{ id: string; name: string }>
    }
    access: {
      posts: { ownerColumn: 'userId' }
      user: { exposeAuthTable: true }
    }
    buckets: 'images'
    api: any
  }
}

const emptyListFetch = (async () =>
  Response.json({ json: { items: [], limit: 100, hasMore: false } })) as (
  request: Request,
) => Promise<Response>

describe('createSyncClient', () => {
  it('lazily materializes table collections with stable identity', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    const posts = api.posts
    expect(posts.collection).toBeDefined()
    expect(typeof posts.scopedCollection).toBe('function')
    expect(typeof posts.collectionByIds).toBe('function')
    expect(api.posts).toBe(posts)
  })

  it('exposes lazy bucket clients under files.*', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    expect(typeof api.files.images.upload).toBe('function')
    expect(api.files.images).toBe(api.files.images)
  })

  it('disables realtime by default outside the browser (SSR)', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    expect(api.realtime).toBeUndefined() // bun test has no `window`
  })

  it('starts and closes typed realtime when requested', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
      realtime: true,
    })
    void api.posts
    expect(api.realtime).toBeDefined()
    api.realtime!.close()
  })
})
