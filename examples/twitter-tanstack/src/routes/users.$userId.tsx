import { useQuery } from '@tanstack/react-query'
import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { BunderstackApiError } from 'bunderstack-query'
import { asTypeId } from 'bunderstack/typeid'
import * as React from 'react'

import { byColumnIn } from '~/api-client'
import { AppShell } from '~/components/AppShell'
import { FollowButton } from '~/components/FollowButton'
import { PostCard } from '~/components/PostCard'
import { UserAvatar } from '~/components/UserAvatar'

function parseUserIdParam(raw: string) {
  try {
    return asTypeId('user', raw)
  } catch {
    throw notFound()
  }
}

export const Route = createFileRoute('/users/$userId')({
  loader: async ({ params, context: { queryClient, api, user: viewer } }) => {
    const userId = parseUserIdParam(params.userId)
    const userPostsParams = {
      userId,
      sort: 'createdAt',
      order: 'desc',
      limit: 100,
      offset: 0,
    } as const

    try {
      await queryClient.ensureQueryData(api.user.getQuery(userId))
      const posts = await queryClient.ensureQueryData(
        api.posts.listQuery(userPostsParams),
      )
      const postIds = posts.items.map((p) => p.id)

      await Promise.all([
        queryClient.ensureQueryData(
          api.likes.listQuery(byColumnIn('postId', postIds)),
        ),
        queryClient.ensureQueryData(
          api.retweets.listQuery(byColumnIn('postId', postIds)),
        ),
        // Aggregate counts only — never fetches the actual follow rows.
        queryClient.ensureQueryData(
          api.follows.listQuery({ followingId: userId, count: true, limit: 1 }),
        ),
        queryClient.ensureQueryData(
          api.follows.listQuery({ followerId: userId, count: true, limit: 1 }),
        ),
        ...(viewer
          ? [
              queryClient.ensureQueryData(
                api.follows.listQuery({
                  followerId: viewer.id,
                  followingId: userId,
                  limit: 1,
                }),
              ),
            ]
          : []),
      ])

      return { userPostsParams }
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
  const { api, user: currentUser } = Route.useRouteContext()
  const { userPostsParams } = Route.useLoaderData()
  const router = useRouter()

  const { data: profile } = useQuery(api.user.getQuery(userId))
  const { data: posts } = useQuery(api.posts.listQuery(userPostsParams))

  const allPosts = React.useMemo(() => posts?.items ?? [], [posts?.items])
  const postIds = React.useMemo(() => allPosts.map((p) => p.id), [allPosts])

  // Scoped to exactly this profile's posts — not the whole table. The only
  // author these posts can have is the profile owner.
  const { data: likes } = useQuery({
    ...api.likes.listQuery(byColumnIn('postId', postIds)),
    enabled: postIds.length > 0,
  })
  const { data: retweets } = useQuery({
    ...api.retweets.listQuery(byColumnIn('postId', postIds)),
    enabled: postIds.length > 0,
  })
  // Aggregate counts only — never fetches the actual follow rows.
  const { data: followerCountData } = useQuery(
    api.follows.listQuery({ followingId: userId, count: true, limit: 1 }),
  )
  const { data: followingCountData } = useQuery(
    api.follows.listQuery({ followerId: userId, count: true, limit: 1 }),
  )
  // Just the one relationship the FollowButton below needs to know about.
  const { data: myRelation } = useQuery({
    ...api.follows.listQuery({
      followerId: currentUser?.id ?? '',
      followingId: userId,
      limit: 1,
    }),
    enabled: !!currentUser,
  })

  const authorMap = React.useMemo(
    () => new Map(profile ? [[profile.id, profile] as const] : []),
    [profile],
  )

  const userPosts = allPosts

  const followerCount = followerCountData?.total ?? 0
  const followingCount = followingCountData?.total ?? 0

  if (!profile) {
    return (
      <AppShell user={currentUser}>
        <p>User not found.</p>
        <Link to="/" search={{ tab: 'for-you' }}>
          Back
        </Link>
      </AppShell>
    )
  }

  return (
    <AppShell user={currentUser}>
      <button type="button" onClick={() => router.history.back()}>
        Back
      </button>

      <article className="card profile-card">
        <UserAvatar name={profile.name} image={profile.image} size={80} />
        <div className="profile-meta">
          <h1>{profile.name}</h1>
          <p>{profile.email}</p>
          {profile.about ? (
            <p className="profile-about">{profile.about}</p>
          ) : null}
          <p>
            <strong>{followingCount}</strong> following ·{' '}
            <strong>{followerCount}</strong> followers
          </p>
          <div className="profile-actions">
            <FollowButton
              currentUserId={currentUser?.id ?? null}
              targetUserId={profile.id}
              follows={myRelation?.items ?? []}
            />
            {currentUser?.id === profile.id ? (
              <Link to="/profile" role="button" className="outline">
                Edit avatar
              </Link>
            ) : null}
          </div>
        </div>
      </article>

      <section>
        <h2>Posts</h2>
        {userPosts.length === 0 ? (
          <article className="card">
            <p>No posts yet.</p>
          </article>
        ) : (
          <div className="feed-list feed-list--x">
            {userPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                author={profile}
                allPosts={allPosts}
                likes={likes?.items ?? []}
                retweets={retweets?.items ?? []}
                authorMap={authorMap}
                currentUserId={currentUser?.id ?? null}
              />
            ))}
          </div>
        )}
      </section>
    </AppShell>
  )
}
