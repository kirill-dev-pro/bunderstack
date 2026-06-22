import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { BunderstackApiError } from 'bunderstack-query'
import * as React from 'react'

import { api, listParams, queryClient } from '~/api-client'
import { AppShell } from '~/components/AppShell'
import { FollowButton } from '~/components/FollowButton'
import { PostCard } from '~/components/PostCard'
import { UserAvatar } from '~/components/UserAvatar'

export const Route = createFileRoute('/users/$userId')({
  loader: async ({ params }) => {
    try {
      const profile = await queryClient.ensureQueryData(
        api.user.getQuery(params.userId),
      )
      const [posts, follows, users, likes, retweets] = await Promise.all([
        queryClient.ensureQueryData(api.posts.listQuery(listParams)),
        queryClient.ensureQueryData(api.follows.listQuery(listParams)),
        queryClient.ensureQueryData(api.user.listQuery(listParams)),
        queryClient.ensureQueryData(api.likes.listQuery(listParams)),
        queryClient.ensureQueryData(api.retweets.listQuery(listParams)),
      ])
      return { profile, posts, follows, users, likes, retweets }
    } catch (err) {
      if (err instanceof BunderstackApiError && err.status === 404)
        throw notFound()
      throw err
    }
  },
  component: UserProfilePage,
})

function UserProfilePage() {
  const { userId } = Route.useParams()
  const { user: currentUser } = Route.useRouteContext()
  const initial = Route.useLoaderData()

  const { data: profileData } = useQuery(api.user.getQuery(userId))
  const { data: postsData } = useQuery(api.posts.listQuery(listParams))
  const { data: followsData } = useQuery(api.follows.listQuery(listParams))
  const { data: usersData } = useQuery(api.user.listQuery(listParams))
  const { data: likesData } = useQuery(api.likes.listQuery(listParams))
  const { data: retweetsData } = useQuery(api.retweets.listQuery(listParams))

  const profile = profileData ?? initial.profile
  const posts = postsData ?? initial.posts
  const follows = followsData ?? initial.follows
  const users = usersData ?? initial.users
  const likes = likesData ?? initial.likes
  const retweets = retweetsData ?? initial.retweets

  const allPosts = posts.items ?? []

  const authorMap = React.useMemo(
    () => new Map((users.items ?? []).map((u) => [u.id, u])),
    [users.items],
  )

  const userPosts = React.useMemo(
    () =>
      allPosts
        .filter((post) => post.userId === userId)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [allPosts, userId],
  )

  const followerCount = (follows.items ?? []).filter(
    (f) => f.followingId === userId,
  ).length
  const followingCount = (follows.items ?? []).filter(
    (f) => f.followerId === userId,
  ).length

  if (!profile) {
    return (
      <AppShell user={currentUser}>
        <p>User not found.</p>
        <Link to="/">Back</Link>
      </AppShell>
    )
  }

  return (
    <AppShell user={currentUser}>
      <Link to="/" className="back-link">
        ← Home
      </Link>

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
              follows={follows.items ?? []}
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
                likes={likes.items ?? []}
                retweets={retweets.items ?? []}
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
