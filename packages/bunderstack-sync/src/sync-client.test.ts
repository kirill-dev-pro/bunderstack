import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

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
  }
}

function makeStreamResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (obj: unknown) =>
      controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)),
  }
}

const emptyListFetch = (async () =>
  Response.json({ items: [], limit: 100, hasMore: false })) as unknown as (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

describe('createSyncClient', () => {
  it('lazily materializes table collections with stable identity', () => {
    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: emptyListFetch,
    })
    const posts = api.posts
    expect(posts.collection).toBeDefined()
    expect(typeof posts.table.list).toBe('function')
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

  it('routes realtime events to lazily-created tables via the resolver', async () => {
    const stream = makeStreamResponse()
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/realtime')) {
        if (init?.method === 'POST')
          return new Response(JSON.stringify({ gap: false }), { status: 200 })
        return stream.response
      }
      return Response.json({ items: [], limit: 100, hasMore: false })
    }) as unknown as typeof fetch

    const api = createSyncClient<FakeApp>({
      queryClient: new QueryClient(),
      fetch: fetchMock,
      realtime: true,
    })
    // Materialize posts AFTER client creation and start its sync so
    // manual realtime writes are accepted.
    await api.posts.collection.stateWhenReady()

    stream.push({ clientId: 'c1' })
    await api.realtime!.subscribe(['posts'])
    stream.push({
      eventId: 1,
      action: 'create',
      table: 'posts',
      record: { id: 'p1', title: 'live', userId: 'u1' },
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(api.posts.collection.get('p1')).toMatchObject({ title: 'live' })
    api.realtime!.close()
  })
})
