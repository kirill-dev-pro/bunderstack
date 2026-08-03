import { QueryClient } from '@tanstack/react-query'
import { describe, it, expect } from 'bun:test'

import {
  createBunderstackSyncClient,
  BunderstackApiError,
  type InferSelect,
  type InferInsert,
  type UploadedFile,
} from './index'

type Schema = {
  posts: {
    $inferSelect: {
      id: string
      title: string
      createdAt: Date
    }
    $inferInsert: {
      id?: string
      title: string
      createdAt?: Date
    }
  }
  user: {
    $inferSelect: {
      id: string
      email: string
    }
    $inferInsert: {
      id?: string
      email: string
    }
  }
}

function expectType<T>(_value: T) {}

function fetchMockFactory() {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/posts')) {
      return new Response(
        JSON.stringify({ items: [], limit: 100, hasMore: false }),
        { status: 200 },
      )
    }
    if (url.includes('/user')) {
      return new Response(
        JSON.stringify({ items: [], limit: 100, hasMore: false }),
        { status: 200 },
      )
    }
    throw new Error(`unhandled request: ${url}`)
  }) as unknown as typeof fetch
}

describe('createBunderstackSyncClient', () => {
  it('builds one collection per table and a files surface per bucket', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts', 'user'] as const,
      buckets: ['attachments'] as const,
      realtime: false,
    })

    expect(api.posts.collection).toBeDefined()
    expect(api.user.collection).toBeDefined()
    expect(api.files.attachments.upload).toBeDefined()
    expect(api.files.attachments.url).toBeDefined()
    expect(api.realtime).toBeUndefined()
  })

  it('preserves schema row types for table collections', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts'] as const,
      buckets: [] as const,
      realtime: false,
    })

    function typecheck() {
      const post = api.posts.collection.get('post_1')
      if (post) {
        expectType<string>(post.title)
        expectType<Date>(post.createdAt)
      }

      api.posts.collection.insert({
        id: 'post_2',
        title: 'Hello',
        createdAt: new Date(),
      })
    }

    expect(typecheck).toBeFunction()
  })

  it('falls back to id-only rows for tables without schema inference', () => {
    type LooseSchema = { posts: unknown }

    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<LooseSchema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts'] as const,
      buckets: [] as const,
      realtime: false,
    })

    function typecheck() {
      const post = api.posts.collection.get('post_1')
      if (post) expectType<string | number>(post.id)
      api.posts.collection.insert({ id: 'post_2' })
    }

    expect(typecheck).toBeFunction()
  })

  it('exposes a realtime client when realtime is true', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts'] as const,
      buckets: [] as const,
      realtime: true,
    })

    expect(api.realtime).toBeDefined()
    api.realtime!.close()
  })

  it('disables realtime by default outside the browser (SSR)', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts'] as const,
      buckets: [] as const,
    })

    expect(api.realtime).toBeUndefined() // bun test has no `window`
  })
})

describe('Re-exported bunderstack-query symbols', () => {
  it('exports BunderstackApiError and can be used with instanceof', () => {
    const error = new BunderstackApiError('Test error', 400)
    expect(error instanceof BunderstackApiError).toBe(true)
    expect(error.message).toBe('Test error')
  })

  it('exports InferSelect, InferInsert, and UploadedFile types for type checking', () => {
    // Type-only test: the imports succeed and TypeScript compilation passes
    // These types are available for use in consuming code
    // If they weren't exported, this file wouldn't compile
    expect(true).toBe(true)
  })
})
