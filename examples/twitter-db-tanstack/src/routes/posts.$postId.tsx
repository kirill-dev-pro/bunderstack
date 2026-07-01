import { useQuery } from '@tanstack/react-query'
import {
  ClientOnly,
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { asTypeId } from 'bunderstack/typeid'
import { BunderstackApiError } from 'bunderstack-sync'
import * as React from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '~/components/AppShell'
import { LoadMore } from '~/components/LoadMore'
import { PostCard } from '~/components/PostCard'
import { ReplyComposer } from '~/components/ReplyComposer'
import { Button } from '~/components/ui/button'
import type { RouterContext } from '~/router'
import type { Post } from '~/utils/posts'

function parsePostIdParam(raw: string) {
  try {
    return asTypeId('post', raw)
  } catch {
    throw notFound()
  }
}

export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params, context: { queryClient, api } }) => {
    const postId = parsePostIdParam(params.postId)
    try {
      await queryClient.ensureQueryData(api.posts.table.getQuery(postId))
    } catch (err) {
      if (err instanceof BunderstackApiError && err.status === 404)
        throw notFound()
      throw err
    }
  },
  component: PostThreadPage,
})

function PostThreadPage() {
  const { postId: postIdParam } = Route.useParams()
  const postId = parsePostIdParam(postIdParam)
  const { user } = Route.useRouteContext()
  const router = useRouter()

  return (
    <AppShell user={user}>
      <header className="flex items-center gap-3 border-b p-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.history.back()}
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Button>
        <h1 className="text-xl font-bold">Post</h1>
      </header>

      <ClientOnly
        fallback={
          <div className="text-muted-foreground p-4 text-sm">Loading…</div>
        }
      >
        <PostThread postId={postId} user={user} />
      </ClientOnly>
    </AppShell>
  )
}

// useLiveQuery's useSyncExternalStore call has no getServerSnapshot arg — it
// cannot run during SSR (@tanstack/react-db@0.1.91). Isolated in its own
// component so the hook is never invoked server-side; ClientOnly only mounts
// children in the browser. The loader's ensureQueryData still primes the
// queryClient cache the single-post table.getQuery reads from, so the
// client's first paint doesn't wait on a fresh network round-trip for it.
function PostThread({
  postId,
  user,
}: {
  postId: Post['id']
  user: RouterContext['user']
}) {
  const { api, queryClient } = Route.useRouteContext()
  const [loadingMore, setLoadingMore] = React.useState(false)

  const { data: post } = useQuery(api.posts.table.getQuery(postId), queryClient)

  // Growing-window replies: cached by options, so the same instance
  // survives re-renders and "load more" refetches in place instead of
  // swapping in a brand new collection.
  const repliesWindow = api.posts.scopedCollection({
    filter: { replyToId: postId },
    sort: 'createdAt',
    order: 'asc',
  })

  const loadMore = React.useCallback(async () => {
    setLoadingMore(true)
    try {
      await repliesWindow.loadMore()
    } finally {
      setLoadingMore(false)
    }
  }, [repliesWindow])

  const { data: replyItems } = useLiveQuery(
    (q) =>
      q
        .from({ post: repliesWindow.collection })
        .orderBy(({ post }) => post.createdAt, 'asc'),
    [repliesWindow.collection],
  )

  const replies = replyItems ?? []
  const allPosts = React.useMemo(
    () => (post ? [post, ...replies] : replies),
    [post, replies],
  )

  // Scoped to exactly the root post's + replies' authors — not the whole
  // user table, which is capped at the default sync limit and would show
  // "Unknown" for any author outside that window once there are more than
  // ~100 users.
  const authorIds = React.useMemo(
    () => Array.from(new Set(allPosts.map((p) => p.userId))).sort(),
    [allPosts],
  )
  const usersByIdCollection = api.user.collectionByIds(authorIds)
  const { data: users } = useLiveQuery(
    (q) => q.from({ user: usersByIdCollection }),
    [usersByIdCollection],
  )
  const { data: likes } = useLiveQuery((q) =>
    q.from({ like: api.likes.collection }),
  )
  const { data: retweets } = useLiveQuery((q) =>
    q.from({ retweet: api.retweets.collection }),
  )

  const authorMap = React.useMemo(
    () => new Map((users ?? []).map((u) => [u.id, u])),
    [users],
  )
  const hasMore = repliesWindow.hasMore()

  if (!post) {
    return (
      <div className="space-y-2 p-4">
        <p>Post not found.</p>
        <Link
          to="/"
          search={{ tab: 'for-you' }}
          className="text-primary hover:underline"
        >
          Back
        </Link>
      </div>
    )
  }

  return (
    <div>
      <PostCard
        post={post}
        author={authorMap.get(post.userId)}
        allPosts={allPosts}
        likes={likes ?? []}
        retweets={retweets ?? []}
        authorMap={authorMap}
        currentUserId={user?.id ?? null}
        variant="detail"
      />

      <ReplyComposer
        user={user}
        replyToId={postId}
        placeholder={`Reply to ${authorMap.get(post.userId)?.name ?? 'this post'}`}
      />

      <section aria-label="Replies">
        {replies.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            No replies yet. Be the first to reply.
          </p>
        ) : (
          replies.map((reply) => (
            <PostCard
              key={reply.id}
              post={reply}
              author={authorMap.get(reply.userId)}
              allPosts={allPosts}
              likes={likes ?? []}
              retweets={retweets ?? []}
              authorMap={authorMap}
              currentUserId={user?.id ?? null}
              variant="reply"
            />
          ))
        )}
        <LoadMore
          hasMore={hasMore}
          loading={loadingMore}
          onLoadMore={() => void loadMore()}
          label="Load more replies"
        />
      </section>
    </div>
  )
}
