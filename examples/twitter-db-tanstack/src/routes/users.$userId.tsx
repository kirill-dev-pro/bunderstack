import { useLiveQuery } from '@tanstack/react-db'
import { useQuery } from '@tanstack/react-query'
import {
  ClientOnly,
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { BunderstackApiError } from 'bunderstack-sync'
import { asTypeId } from 'bunderstack/typeid'
import { ArrowLeft } from 'lucide-react'
import * as React from 'react'

import type { RouterContext } from '~/router'

import { AppShell } from '~/components/AppShell'
import { FollowButton } from '~/components/FollowButton'
import { LoadMore } from '~/components/LoadMore'
import { PostCard } from '~/components/PostCard'
import { Button } from '~/components/ui/button'
import { UserAvatar } from '~/components/UserAvatar'

function parseUserIdParam(raw: string) {
  try {
    return asTypeId('user', raw)
  } catch {
    throw notFound()
  }
}

export const Route = createFileRoute('/users/$userId')({
  loader: async ({ params, context: { queryClient, api } }) => {
    const userId = parseUserIdParam(params.userId)
    try {
      await queryClient.ensureQueryData(api.user.table.getQuery(userId))
    } catch (err) {
      if (err instanceof BunderstackApiError && err.status === 404)
        throw notFound()
      throw err
    }
  },
  component: UserProfilePage,
})

function UserProfilePage() {
  const { userId: userIdParam } = Route.useParams()
  const userId = parseUserIdParam(userIdParam)
  const { user: currentUser } = Route.useRouteContext()
  const router = useRouter()

  return (
    <AppShell user={currentUser}>
      <div className="border-b p-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.history.back()}
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Button>
      </div>

      <ClientOnly
        fallback={
          <div className="text-muted-foreground p-4 text-sm">Loading…</div>
        }
      >
        <UserProfile userId={userId} currentUser={currentUser} />
      </ClientOnly>
    </AppShell>
  )
}

// useLiveQuery's useSyncExternalStore call has no getServerSnapshot arg — it
// cannot run during SSR (@tanstack/react-db@0.1.91). Isolated in its own
// component so the hook is never invoked server-side.
function UserProfile({
  userId,
  currentUser,
}: {
  userId: ReturnType<typeof parseUserIdParam>
  currentUser: RouterContext['user']
}) {
  const { api, queryClient } = Route.useRouteContext()
  const [loadingMore, setLoadingMore] = React.useState(false)

  const { data: profile } = useQuery(
    api.user.table.getQuery(userId),
    queryClient,
  )

  // Growing-window profile posts: cached by options, so the same instance
  // survives re-renders and "load more" refetches in place instead of
  // swapping in a brand new collection.
  const userPosts = api.posts.scopedCollection({
    filter: { userId },
    sort: 'createdAt',
    order: 'desc',
  })

  const loadMore = React.useCallback(async () => {
    setLoadingMore(true)
    try {
      await userPosts.loadMore()
    } finally {
      setLoadingMore(false)
    }
  }, [userPosts])

  const { data: postItems } = useLiveQuery(
    (q) =>
      q
        .from({ post: userPosts.collection })
        .orderBy(({ post }) => post.createdAt, 'desc'),
    [userPosts.collection],
  )
  const { data: likes } = useLiveQuery((q) =>
    q.from({ like: api.likes.collection }),
  )
  const { data: retweets } = useLiveQuery((q) =>
    q.from({ retweet: api.retweets.collection }),
  )
  const { data: follows } = useLiveQuery((q) =>
    q.from({ follow: api.follows.collection }),
  )

  // Aggregate counts only — never fetches the actual follow rows. TanStack
  // DB collections don't expose a server-side count aggregate, so this goes
  // through the raw REST list() primitive directly, same as before.
  const { data: followerCountData } = useQuery(
    api.follows.table.listQuery({ followingId: userId, count: true, limit: 1 }),
    queryClient,
  )
  const { data: followingCountData } = useQuery(
    api.follows.table.listQuery({ followerId: userId, count: true, limit: 1 }),
    queryClient,
  )

  const allPosts = postItems ?? []
  const hasMore = userPosts.hasMore()

  const authorMap = React.useMemo(
    () => new Map(profile ? [[profile.id, profile] as const] : []),
    [profile],
  )

  const followerCount = followerCountData?.total ?? 0
  const followingCount = followingCountData?.total ?? 0

  if (!profile) {
    return (
      <div className="space-y-2 p-4">
        <p>User not found.</p>
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
      <article className="flex gap-4 border-b p-4">
        <UserAvatar name={profile.name} image={profile.image} size={80} />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-bold">{profile.name}</h1>
          <p className="text-muted-foreground">{profile.email}</p>
          {profile.about ? <p>{profile.about}</p> : null}
          <p className="text-sm">
            <strong>{followingCount}</strong> following ·{' '}
            <strong>{followerCount}</strong> followers
          </p>
          <div className="flex items-center gap-2 pt-1">
            <FollowButton
              currentUserId={currentUser?.id ?? null}
              targetUserId={profile.id}
              follows={follows ?? []}
            />
            {currentUser?.id === profile.id ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/profile">Edit avatar</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </article>

      <section>
        <h2 className="p-4 pb-2 text-lg font-semibold">Posts</h2>
        {allPosts.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">No posts yet.</p>
        ) : (
          <div>
            {allPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                author={profile}
                allPosts={allPosts}
                likes={likes ?? []}
                retweets={retweets ?? []}
                authorMap={authorMap}
                currentUserId={currentUser?.id ?? null}
              />
            ))}
            <LoadMore
              hasMore={hasMore}
              loading={loadingMore}
              onLoadMore={() => void loadMore()}
            />
          </div>
        )}
      </section>
    </div>
  )
}
