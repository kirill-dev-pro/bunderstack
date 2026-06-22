import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { BunderstackApiError } from 'bunderstack-query'
import { api, listParams, queryClient } from '~/api-client'
import { AppShell } from '~/components/AppShell'
import { PostCard } from '~/components/PostCard'
import { ReplyComposer } from '~/components/ReplyComposer'
import { getThreadReplies } from '~/utils/posts'

export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params }) => {
    const postId = Number(params.postId)
    if (!Number.isFinite(postId)) throw notFound()

    try {
      const [post, posts, users, likes, retweets] = await Promise.all([
        queryClient.ensureQueryData(api.posts.getQuery(postId)),
        queryClient.ensureQueryData(api.posts.listQuery(listParams)),
        queryClient.ensureQueryData(api.user.listQuery(listParams)),
        queryClient.ensureQueryData(api.likes.listQuery(listParams)),
        queryClient.ensureQueryData(api.retweets.listQuery(listParams)),
      ])
      return { post, posts, users, likes, retweets }
    } catch (err) {
      if (err instanceof BunderstackApiError && err.status === 404) throw notFound()
      throw err
    }
  },
  component: PostThreadPage,
})

function PostThreadPage() {
  const { postId: postIdParam } = Route.useParams()
  const postId = Number(postIdParam)
  const { user } = Route.useRouteContext()
  const initial = Route.useLoaderData()

  const { data: postData } = useQuery(api.posts.getQuery(postId))
  const { data: postsData } = useQuery(api.posts.listQuery(listParams))
  const { data: usersData } = useQuery(api.user.listQuery(listParams))
  const { data: likesData } = useQuery(api.likes.listQuery(listParams))
  const { data: retweetsData } = useQuery(api.retweets.listQuery(listParams))

  const post = postData ?? initial.post
  const posts = postsData ?? initial.posts
  const users = usersData ?? initial.users
  const likes = likesData ?? initial.likes
  const retweets = retweetsData ?? initial.retweets

  const allPosts = posts.items ?? []
  const authorMap = React.useMemo(
    () => new Map((users.items ?? []).map((u) => [u.id, u])),
    [users.items],
  )

  const replies = React.useMemo(() => getThreadReplies(postId, allPosts), [postId, allPosts])

  if (!post) {
    return (
      <AppShell user={user}>
        <p>Post not found.</p>
        <Link to="/">Back</Link>
      </AppShell>
    )
  }

  return (
    <AppShell user={user}>
      <header className="thread-header">
        <Link to="/" className="back-link">
          ← Back
        </Link>
        <h1>Post</h1>
      </header>

      <div className="thread-main">
        <PostCard
          post={post}
          author={authorMap.get(post.userId)}
          allPosts={allPosts}
          likes={likes.items ?? []}
          retweets={retweets.items ?? []}
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
          {replies.length === 0 ? (
            <p className="thread-empty">
              <small>No replies yet. Be the first to reply.</small>
            </p>
          ) : (
            replies.map((reply) => (
              <PostCard
                key={reply.id}
                post={reply}
                author={authorMap.get(reply.userId)}
                allPosts={allPosts}
                likes={likes.items ?? []}
                retweets={retweets.items ?? []}
                authorMap={authorMap}
                currentUserId={user?.id ?? null}
                variant="reply"
              />
            ))
          )}
        </section>
      </div>
    </AppShell>
  )
}
