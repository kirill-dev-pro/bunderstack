import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { asTypeId } from 'bunderstack/typeid'
import { BunderstackApiError } from 'bunderstack-query'
import * as React from 'react'

import { api, listParams, queryClient, replyParams } from '~/api-client'
import { AppShell } from '~/components/AppShell'
import { LoadMore } from '~/components/LoadMore'
import { PostCard } from '~/components/PostCard'
import { ReplyComposer } from '~/components/ReplyComposer'

function parsePostIdParam(raw: string) {
  try {
    return asTypeId('post', raw)
  } catch {
    throw notFound()
  }
}

export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params }) => {
    const postId = parsePostIdParam(params.postId)

    const repliesQuery = replyParams(postId)

    try {
      await Promise.all([
        queryClient.ensureQueryData(api.posts.getQuery(postId)),
        queryClient.prefetchInfiniteQuery(
          api.posts.listInfiniteQuery(repliesQuery),
        ),
        queryClient.ensureQueryData(api.user.listQuery(listParams)),
        queryClient.ensureQueryData(api.likes.listQuery(listParams)),
        queryClient.ensureQueryData(api.retweets.listQuery(listParams)),
      ])
      return { repliesQuery }
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
  const initial = Route.useLoaderData()
  const router = useRouter()
  const repliesQuery = initial.repliesQuery

  const { data: postData } = useQuery(api.posts.getQuery(postId))
  const {
    data: repliesData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(api.posts.listInfiniteQuery(repliesQuery))
  const { data: usersData } = useQuery(api.user.listQuery(listParams))
  const { data: likesData } = useQuery(api.likes.listQuery(listParams))
  const { data: retweetsData } = useQuery(api.retweets.listQuery(listParams))

  const post = postData
  const users = usersData
  const likes = likesData
  const retweets = retweetsData

  const replyItems = React.useMemo(
    () => repliesData?.pages.flatMap((page) => page.items) ?? [],
    [repliesData?.pages],
  )

  const allPosts = React.useMemo(() => {
    if (!post) return replyItems
    return [post, ...replyItems]
  }, [post, replyItems])

  const authorMap = React.useMemo(
    () => new Map((users?.items ?? []).map((u) => [u.id, u])),
    [users?.items],
  )

  if (!post) {
    return (
      <AppShell user={user}>
        <p>Post not found.</p>
        <Link to="/" search={{ tab: 'for-you' }}>
          Back
        </Link>
      </AppShell>
    )
  }

  return (
    <AppShell user={user}>
      <header className="thread-header">
        <button type="button" onClick={() => router.history.back()}>
          ← Back
        </button>
        <h1>Post</h1>
      </header>

      <div className="thread-main">
        <PostCard
          post={post}
          author={authorMap.get(post.userId)}
          allPosts={allPosts}
          likes={likes?.items ?? []}
          retweets={retweets?.items ?? []}
          authorMap={authorMap}
          currentUserId={user?.id ?? null}
          variant="detail"
        />

        <ReplyComposer
          user={user}
          replyToId={postId}
          placeholder={`Reply to ${authorMap.get(post.userId)?.name ?? 'this post'}`}
        />

        <section className="thread-replies" aria-label="Replies">
          {replyItems.length === 0 ? (
            <p className="thread-empty">
              <small>No replies yet. Be the first to reply.</small>
            </p>
          ) : (
            replyItems.map((reply) => (
              <PostCard
                key={reply.id}
                post={reply}
                author={authorMap.get(reply.userId)}
                allPosts={allPosts}
                likes={likes?.items ?? []}
                retweets={retweets?.items ?? []}
                authorMap={authorMap}
                currentUserId={user?.id ?? null}
                variant="reply"
              />
            ))
          )}
          <LoadMore
            hasMore={Boolean(hasNextPage)}
            loading={isFetchingNextPage}
            onLoadMore={() => void fetchNextPage()}
            label="Load more replies"
          />
        </section>
      </div>
    </AppShell>
  )
}
