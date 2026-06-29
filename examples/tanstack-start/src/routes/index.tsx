import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { api, feedParams, listParams, queryClient } from '~/api-client'
import { AppShell } from '~/components/AppShell'
import {
  ComposePostDialog,
  ComposePostTrigger,
} from '~/components/ComposePostDialog'
import { FollowButton } from '~/components/FollowButton'
import { LoadMore } from '~/components/LoadMore'
import { PostCard } from '~/components/PostCard'
import { UserAvatar } from '~/components/UserAvatar'
import { showDialog } from '~/utils/oat'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab:
      search.tab === 'following'
        ? ('following' as const)
        : ('for-you' as const),
  }),
  loader: async () => {
    await Promise.all([
      queryClient.prefetchInfiniteQuery(
        api.posts.listInfiniteQuery(feedParams),
      ),
      queryClient.ensureQueryData(api.user.listQuery(listParams)),
      queryClient.ensureQueryData(api.follows.listQuery(listParams)),
      queryClient.ensureQueryData(api.likes.listQuery(listParams)),
      queryClient.ensureQueryData(api.retweets.listQuery(listParams)),
    ])
  },
  component: FeedPage,
})

function FeedPage() {
  const { user } = Route.useRouteContext()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const composeRef = React.useRef<HTMLDialogElement>(null)

  const {
    data: postsData,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(api.posts.listInfiniteQuery(feedParams))
  const { data: usersData } = useQuery(api.user.listQuery(listParams))
  const { data: followsData } = useQuery(api.follows.listQuery(listParams))
  const { data: likesData } = useQuery(api.likes.listQuery(listParams))
  const { data: retweetsData } = useQuery(api.retweets.listQuery(listParams))

  const allPosts = React.useMemo(
    () => postsData?.pages.flatMap((page) => page.items) ?? [],
    [postsData?.pages],
  )
  const users = usersData
  const follows = followsData
  const likes = likesData
  const retweets = retweetsData

  const authorMap = React.useMemo(
    () => new Map((users?.items ?? []).map((u) => [u.id, u])),
    [users?.items],
  )

  const followingIds = React.useMemo(() => {
    if (!user) return new Set<string>()
    return new Set(
      (follows?.items ?? [])
        .filter((f) => f.followerId === user.id)
        .map((f) => f.followingId),
    )
  }, [follows?.items, user])

  const feed = React.useMemo(() => {
    if (tab === 'following' && user) {
      return allPosts.filter(
        (p) => p.userId === user.id || followingIds.has(p.userId),
      )
    }
    return allPosts
  }, [allPosts, tab, user, followingIds])

  const suggestions = React.useMemo(() => {
    if (!user) return (users?.items ?? []).slice(0, 3)
    return (users?.items ?? [])
      .filter((u) => u.id !== user.id && !followingIds.has(u.id))
      .slice(0, 3)
  }, [user, users?.items, followingIds])

  const openCompose = () => showDialog(composeRef.current)

  const aside =
    suggestions.length > 0 ? (
      <aside className="app-aside" aria-label="Suggestions">
        <article className="card">
          <header>
            <h3>Who to follow</h3>
          </header>
          <ul className="who-list">
            {suggestions.map((person) => (
              <li key={person.id} className="who-row">
                <Link
                  to="/users/$userId"
                  params={{ userId: person.id }}
                  className="who-user"
                >
                  <UserAvatar
                    name={person.name}
                    image={person.image}
                    size={40}
                  />
                  <div>
                    <strong>{person.name}</strong>
                    <small>{person.email}</small>
                  </div>
                </Link>
                <FollowButton
                  currentUserId={user?.id ?? null}
                  targetUserId={person.id}
                  follows={follows?.items ?? []}
                />
              </li>
            ))}
          </ul>
        </article>
      </aside>
    ) : null

  return (
    <AppShell
      user={user}
      onCompose={user ? openCompose : undefined}
      aside={aside}
    >
      <header className="feed-header">
        <h1>Home</h1>
        <nav aria-label="Feed tabs" className="feed-tabs">
          <button
            type="button"
            className={tab === 'for-you' ? undefined : 'outline'}
            onClick={() => navigate({ search: { tab: 'for-you' } })}
          >
            For you
          </button>
          <button
            type="button"
            className={tab === 'following' ? undefined : 'outline'}
            disabled={!user}
            onClick={() => navigate({ search: { tab: 'following' } })}
          >
            Following
          </button>
        </nav>
      </header>

      <ComposePostTrigger user={user} onOpen={openCompose} />
      {user ? <ComposePostDialog dialogRef={composeRef} user={user} /> : null}

      {error ? (
        <output data-variant="danger">
          <p>{error.message}</p>
        </output>
      ) : null}

      {feed.length === 0 ? (
        <article className="card">
          <p>
            {tab === 'following'
              ? 'Follow people to see their posts here.'
              : 'No posts yet. Run bun run seed or compose the first post.'}
          </p>
        </article>
      ) : (
        <div className="feed-list feed-list--x">
          {feed.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              author={authorMap.get(post.userId)}
              allPosts={allPosts}
              likes={likes?.items ?? []}
              retweets={retweets?.items ?? []}
              authorMap={authorMap}
              currentUserId={user?.id ?? null}
            />
          ))}
          <LoadMore
            hasMore={Boolean(hasNextPage)}
            loading={isFetchingNextPage}
            onLoadMore={() => void fetchNextPage()}
          />
        </div>
      )}
    </AppShell>
  )
}
