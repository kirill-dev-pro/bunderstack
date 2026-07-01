import { QueryClient } from '@tanstack/react-query'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { createBunderstackSyncClient } from 'bunderstack-sync'
import { createIsomorphicFn } from '@tanstack/react-start'

import type * as schema from './schema'
import type { InferSelect } from 'bunderstack-sync'
import type { posts, user } from './schema'

type Post = InferSelect<typeof posts>
type User = InferSelect<typeof user>

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
 * PAGE_SIZE by the server) until the current desired count is collected or
 * the table runs out.
 *
 * The collection itself is stable across "load more" clicks — its queryKey
 * never changes, and `getDesiredCount` is read fresh on every (re)fetch, so
 * bumping the count and calling `.utils.refetch()` re-runs the same
 * queryFn for a bigger slice instead of creating a brand new collection.
 * That matters because a new collection starts from an empty local sync
 * state: swapping collections on every "load more" briefly renders zero
 * items while the new one does its first fetch, which collapses the list's
 * height and resets scroll position. Refetching in place only ever adds
 * rows (every previously-fetched id is still included in the larger
 * result), so the already-rendered posts never unmount.
 *
 * Read-only view: mutations (create/update/delete) go through the plain
 * `api.posts.collection` from createSyncApi, not this one.
 */
function createScopedPostsCollection(
  queryClient: QueryClient,
  table: PostsTable,
  getDesiredCount: () => number,
  config: {
    queryKeySuffix: readonly unknown[]
    order: 'asc' | 'desc'
    filter: Record<string, unknown>
  },
) {
  return createCollection(
    queryCollectionOptions<Post>({
      queryKey: ['posts', ...config.queryKeySuffix],
      queryFn: async () => {
        const desiredCount = getDesiredCount()
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
  getDesiredCount: () => number,
) {
  return createScopedPostsCollection(queryClient, table, getDesiredCount, {
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
  getDesiredCount: () => number,
) {
  return createScopedPostsCollection(queryClient, table, getDesiredCount, {
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
  getDesiredCount: () => number,
) {
  return createScopedPostsCollection(queryClient, table, getDesiredCount, {
    queryKeySuffix: ['byUser', userId],
    order: 'desc',
    filter: { userId },
  })
}

type UserTable = SyncApi['user']['table']

/**
 * Users scoped to exactly a given set of ids, via the server's `?id=a,b,c`
 * IN-filter (chunked at PAGE_SIZE, matching the server's own per-request
 * cap). The general `api.user.collection` only syncs the default 100 rows —
 * fine for a "some users" sample, but resolving a specific set of post
 * authors against it silently drops (shows "Unknown" for) anyone outside
 * that window once the user table is larger than ~100 rows. `ids` should be
 * deduped by the caller so the queryKey stays stable across renders that
 * don't actually introduce a new author.
 */
export function createUsersByIdCollection(
  queryClient: QueryClient,
  table: UserTable,
  ids: readonly Post['userId'][],
) {
  return createCollection(
    queryCollectionOptions<User>({
      queryKey: ['user', 'byId', ids],
      queryFn: async () => {
        if (ids.length === 0) return []
        const items: User[] = []
        for (let i = 0; i < ids.length; i += PAGE_SIZE) {
          const chunk = ids.slice(i, i + PAGE_SIZE)
          const page = await table.list({
            id: chunk.join(','),
            limit: chunk.length,
          })
          items.push(...(page.items as User[]))
        }
        return items
      },
      queryClient,
      getKey: (item) => item.id,
    }),
  )
}
