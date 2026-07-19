import { QueryClient } from '@tanstack/react-query'
import { describe, it, expect } from 'bun:test'

import { createSyncRealtimeClient } from './realtime-sync'

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
    end: () => controller.close(),
  }
}

function fakeCollection() {
  const upserts: unknown[] = []
  const deletes: unknown[] = []
  let refetchCount = 0
  return {
    upserts,
    deletes,
    get refetchCount() {
      return refetchCount
    },
    utils: {
      writeUpsert: (item: unknown) => upserts.push(item),
      writeDelete: (key: unknown) => deletes.push(key),
      refetch: async () => {
        refetchCount++
      },
    },
  }
}

describe('createSyncRealtimeClient', () => {
  it('routes create/update events to writeUpsert on the matching collection', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: false }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts'])
    stream.push({
      eventId: 1,
      action: 'create',
      table: 'posts',
      record: { id: 'post_1', title: 'A' },
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.upserts).toEqual([{ id: 'post_1', title: 'A' }])
    rt.close()
  })

  it('routes delete events to writeDelete with the record id', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: false }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts'])
    stream.push({
      eventId: 1,
      action: 'delete',
      table: 'posts',
      record: { id: 'post_1' },
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.deletes).toEqual(['post_1'])
    rt.close()
  })

  it('refetches every collection on gap instead of patching individual records', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const users = fakeCollection()
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: true }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts, users },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts', 'users'])
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.refetchCount).toBe(1)
    expect(users.refetchCount).toBe(1)
    rt.close()
  })

  it('handles refetch rejection gracefully and refetches other collections', async () => {
    const stream = makeStreamResponse()
    const posts = fakeCollection()
    const errorLogs: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => errorLogs.push(args)

    const users = {
      ...fakeCollection(),
      utils: {
        ...fakeCollection().utils,
        refetch: async () => {
          throw new Error('network error')
        },
      },
    }

    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ gap: true }), { status: 200 })
      return stream.response
    }) as unknown as typeof fetch

    const rt = createSyncRealtimeClient({
      baseUrl: 'http://x/api',
      queryClient: new QueryClient(),
      fetch: fetchMock,
      collections: { posts, users },
    })
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['posts', 'users'])
    await new Promise((r) => setTimeout(r, 5))

    expect(posts.refetchCount).toBe(1)
    expect(errorLogs.length).toBe(1)
    expect(errorLogs[0]).toContain(
      'bunderstack-sync: gap-recovery refetch failed',
    )
    console.error = originalError
    rt.close()
  })
})
