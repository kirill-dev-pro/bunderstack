import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { byColumnIn, feedParams } from '~/api-client'
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
  loader: async ({ context: { queryClient, api, user } }) => {
    // Fetch (not just prefetch) so the first page's data is available here
    // to derive which authors/likes/retweets are actually needed — avoids a
    // client-only fetch waterfall on first paint.
    const firstPage = await queryClient.fetchInfiniteQuery(
      api.posts.listInfiniteQuery(feedParams),
    )
    const posts = firstPage.pages.flatMap((page) => page.items)
    const authorIds = posts.map((p) => p.userId)
    const postIds = posts.map((p) => p.id)

    await Promise.all([
      queryClient.ensureQueryData(
        api.user.listQuery(byColumnIn('id', authorIds)),
      ),
      queryClient.ensureQueryData(
        api.likes.listQuery(byColumnIn('postId', postIds)),
      ),
      queryClient.ensureQueryData(
        api.retweets.listQuery(byColumnIn('postId', postIds)),
      ),
      queryClient.ensureQueryData(api.user.listQuery({ limit: 20 })),
      ...(user
        ? [
            queryClient.ensureQueryData(
              api.follows.listQuery(byColumnIn('followerId', [user.id])),
            ),
          ]
        : []),
    ])
  },
  component: FeedPage,
})

function FeedPage() {
  const { api, user } = Route.useRouteContext()
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

  const allPosts = React.useMemo(
    () => postsData?.pages.flatMap((page) => page.items) ?? [],
    [postsData?.pages],
  )
  const authorIds = React.useMemo(
    () => allPosts.map((p) => p.userId),
    [allPosts],
  )
  const postIds = React.useMemo(() => allPosts.map((p) => p.id), [allPosts])

  // Scoped to exactly the posts on this page — not the whole table.
  const { data: usersData } = useQuery({
    ...api.user.listQuery(byColumnIn('id', authorIds)),
    enabled: authorIds.length > 0,
  })
  const { data: likesData } = useQuery({
    ...api.likes.listQuery(byColumnIn('postId', postIds)),
    enabled: postIds.length > 0,
  })
  const { data: retweetsData } = useQuery({
    ...api.retweets.listQuery(byColumnIn('postId', postIds)),
    enabled: postIds.length > 0,
  })
  // The current user's own follow edges — bounded by how many people they
  // follow, unlike fetching every row in the follows table.
  const { data: myFollowsData } = useQuery({
    ...api.follows.listQuery(byColumnIn('followerId', user ? [user.id] : [])),
    enabled: !!user,
  })
  // A small, intentionally non-exhaustive sample to source "Who to follow"
  // suggestions from.
  const { data: suggestionPoolData } = useQuery(
    api.user.listQuery({ limit: 20 }),
  )

  const likes = likesData
  const retweets = retweetsData

  const authorMap = React.useMemo(
    () => new Map((usersData?.items ?? []).map((u) => [u.id, u])),
    [usersData?.items],
  )

  const followingIds = React.useMemo(
    () => new Set((myFollowsData?.items ?? []).map((f) => f.followingId)),
    [myFollowsData?.items],
  )

  const feed = React.useMemo(() => {
    if (tab === 'following' && user) {
      return allPosts.filter(
        (p) => p.userId === user.id || followingIds.has(p.userId),
      )
    }
    return allPosts
  }, [allPosts, tab, user, followingIds])

  const suggestions = React.useMemo(() => {
    const pool = suggestionPoolData?.items ?? []
    if (!user) return pool.slice(0, 3)
    return pool
      .filter((u) => u.id !== user.id && !followingIds.has(u.id))
      .slice(0, 3)
  }, [user, suggestionPoolData?.items, followingIds])

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
                  follows={myFollowsData?.items ?? []}
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
