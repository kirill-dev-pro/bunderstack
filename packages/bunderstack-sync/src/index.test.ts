import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import {
  createBunderstackSyncClient,
  BunderstackApiError,
  type InferSelect,
  type InferInsert,
  type UploadedFile,
} from './index'

type Schema = {
  posts: unknown
  user: unknown
}

function fetchMockFactory() {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/posts')) {
      return new Response(JSON.stringify({ items: [], limit: 100, hasMore: false }), { status: 200 })
    }
    if (url.includes('/user')) {
      return new Response(JSON.stringify({ items: [], limit: 100, hasMore: false }), { status: 200 })
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

  it('exposes a realtime client when realtime is true (default)', () => {
    const queryClient = new QueryClient()
    const api = createBunderstackSyncClient<Schema>().with({
      queryClient,
      fetch: fetchMockFactory(),
      tables: ['posts'] as const,
      buckets: [] as const,
    })

    expect(api.realtime).toBeDefined()
    api.realtime!.close()
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
