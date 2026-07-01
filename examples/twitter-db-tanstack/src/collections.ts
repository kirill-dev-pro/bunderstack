import { QueryClient } from '@tanstack/react-query'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { createBunderstackSyncClient } from 'bunderstack-sync'
import { createIsomorphicFn } from '@tanstack/react-start'

import type * as schema from './schema'
import type { InferSelect } from 'bunderstack-sync'
import type { posts } from './schema'

type Post = InferSelect<typeof posts>

/**
 * Rows per underlying HTTP request. The server hard-caps every list() call
 * at 200 (MAX_LIST_LIMIT in packages/bunderstack/src/list-query.ts) — this
 * matches that cap exactly so a single page always requests the max the
 * server will actually honor.
 */
const PAGE_SIZE = 200

/** Bun/Node fetch requires absolute URLs during SSR; the browser accepts `/api/...`. */
const isomorphicFetch = createIsomorphicFn()
  .client((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  .server(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      let origin: string
      try {
        const { getRequest } = await import('@tanstack/react-start/server')
        origin = new URL(getRequest().url).origin
      } catch {
        origin =
          process.env.APP_URL ??
          process.env.BETTER_AUTH_URL ??
          'http://localhost:3003'
      }
      return fetch(new URL(input, origin), init)
    }
    return fetch(input, init)
  })

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
}

export function createSyncApi(queryClient: QueryClient) {
  return createBunderstackSyncClient<typeof schema>().with({
    queryClient,
    fetch: isomorphicFetch,
    tables: ['posts', 'user', 'follows', 'likes', 'retweets'] as const,
    buckets: ['attachments', 'avatars'] as const,
    // Realtime needs a browser-side persistent connection; skip it during SSR.
    realtime: typeof window !== 'undefined',
  })
}

export type SyncApi = ReturnType<typeof createSyncApi>

type PostsTable = SyncApi['posts']['table']

/**
 * Growing-window, cursor-accumulating posts collection shared by the feed
 * and a single thread's replies: walks server pages (each capped at
 * PAGE_SIZE by the server) until `desiredCount` rows are collected or the
 * table runs out. Re-created (new queryKey) each time `desiredCount` grows,
 * so "load more" is just bumping a number — but unlike a naive single
 * list() call with an ever-larger `limit`, this actually walks multiple
 * server-bounded pages instead of being silently clamped at 200 total rows.
 *
 * Read-only view: mutations (create/update/delete) go through the plain
 * `api.posts.collection` from createSyncApi, not this one.
 */
function createScopedPostsCollection(
  queryClient: QueryClient,
  table: PostsTable,
  desiredCount: number,
  config: {
    queryKeySuffix: readonly unknown[]
    order: 'asc' | 'desc'
    filter: Record<string, unknown>
  },
) {
  return createCollection(
    queryCollectionOptions<Post>({
      queryKey: ['posts', ...config.queryKeySuffix, desiredCount],
      queryFn: async () => {
        const items: Post[] = []
        let cursor: string | undefined
        while (items.length < desiredCount) {
          // Only request as many rows as still needed for this page (capped
          // at PAGE_SIZE, the server's own max) — never over-fetch just
          // because a later page might need more.
          const remaining = Math.min(PAGE_SIZE, desiredCount - items.length)
          const page = await table.list({
            ...config.filter,
            sort: 'createdAt',
            order: config.order,
            cursorMode: true,
            limit: remaining,
            ...(cursor ? { cursor } : {}),
          })
          items.push(...(page.items as Post[]))
          if (!page.hasMore || !page.nextCursor) break
          cursor = page.nextCursor
        }
        return items.slice(0, desiredCount)
      },
      queryClient,
      getKey: (item) => item.id,
    }),
  )
}

/** Root-level posts, newest-first — the home feed. */
export function createFeedPostsCollection(
  queryClient: QueryClient,
  table: PostsTable,
  desiredCount: number,
) {
  return createScopedPostsCollection(queryClient, table, desiredCount, {
    queryKeySuffix: ['feed'],
    order: 'desc',
    filter: { replyToId: null },
  })
}

/** Replies to a single post, oldest-first — a thread page. */
export function createRepliesCollection(
  queryClient: QueryClient,
  table: PostsTable,
  postId: Post['id'],
  desiredCount: number,
) {
  return createScopedPostsCollection(queryClient, table, desiredCount, {
    queryKeySuffix: ['replies', postId],
    order: 'asc',
    filter: { replyToId: postId },
  })
}

/** One author's posts, newest-first — a profile page. */
export function createUserPostsCollection(
  queryClient: QueryClient,
  table: PostsTable,
  userId: Post['userId'],
  desiredCount: number,
) {
  return createScopedPostsCollection(queryClient, table, desiredCount, {
    queryKeySuffix: ['byUser', userId],
    order: 'desc',
    filter: { userId },
  })
}
