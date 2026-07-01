import * as React from 'react'
import { ClientOnly, Link, createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'

import { AppShell } from '~/components/AppShell'
import {
  ComposePostDialog,
  ComposePostTrigger,
} from '~/components/ComposePostDialog'
import { FollowButton } from '~/components/FollowButton'
import { LoadMore } from '~/components/LoadMore'
import { PostCard } from '~/components/PostCard'
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { UserAvatar } from '~/components/UserAvatar'
import type { RouterContext } from '~/router'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab:
      search.tab === 'following'
        ? ('following' as const)
        : ('for-you' as const),
  }),
  component: FeedPage,
})

function FeedPage() {
  const { user } = Route.useRouteContext()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [composeOpen, setComposeOpen] = React.useState(false)

  return (
    <AppShell
      user={user}
      onCompose={user ? () => setComposeOpen(true) : undefined}
      aside={
        <ClientOnly fallback={null}>
          <SuggestionsAside user={user} />
        </ClientOnly>
      }
    >
      <header className="border-b p-4">
        <h1 className="text-xl font-bold">Home</h1>
        <Tabs
          value={tab}
          onValueChange={(value) =>
            navigate({
              search: { tab: value === 'following' ? 'following' : 'for-you' },
            })
          }
          className="mt-2"
        >
          <TabsList>
            <TabsTrigger value="for-you">For you</TabsTrigger>
            <TabsTrigger value="following" disabled={!user}>
              Following
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <ComposePostTrigger user={user} onOpen={() => setComposeOpen(true)} />
      {user ? (
        <ComposePostDialog
          open={composeOpen}
          onOpenChange={setComposeOpen}
          user={user}
        />
      ) : null}

      <ClientOnly
        fallback={
          <div className="text-muted-foreground p-4 text-sm">Loading…</div>
        }
      >
        <FeedList tab={tab} user={user} />
      </ClientOnly>
    </AppShell>
  )
}

// useLiveQuery's useSyncExternalStore call has no getServerSnapshot arg — it
// cannot run during SSR (@tanstack/react-db@0.1.91). Isolated in its own
// component so the hook is never invoked server-side; ClientOnly only
// mounts children in the browser.
function FeedList({
  tab,
  user,
}: {
  tab: 'for-you' | 'following'
  user: RouterContext['user']
}) {
  const { api } = Route.useRouteContext()
  const [loadingMore, setLoadingMore] = React.useState(false)

  // Growing-window feed: the library caches this by its options, so the
  // same instance survives re-renders and "load more" refetches in place —
  // already-rendered posts never unmount (no scroll jumps).
  const feedWindow = api.posts.scopedCollection({
    filter: { replyToId: null },
    sort: 'createdAt',
    order: 'desc',
  })

  const loadMore = React.useCallback(async () => {
    setLoadingMore(true)
    try {
      await feedWindow.loadMore()
    } finally {
      setLoadingMore(false)
    }
  }, [feedWindow])

  const { data: allPosts } = useLiveQuery(
    (q) =>
      q
        .from({ post: feedWindow.collection })
        .orderBy(({ post }) => post.createdAt, 'desc'),
    [feedWindow.collection],
  )

  const posts = allPosts ?? []

  // Scoped to exactly this page's post authors — not the whole user table,
  // which is capped at the default sync limit and would show "Unknown" for
  // any author outside that window once there are more than ~100 users.
  const authorIds = React.useMemo(
    () => Array.from(new Set(posts.map((p) => p.userId))).sort(),
    [posts],
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
  const { data: follows } = useLiveQuery((q) =>
    q.from({ follow: api.follows.collection }),
  )

  const authorMap = React.useMemo(
    () => new Map((users ?? []).map((u) => [u.id, u])),
    [users],
  )

  const followingIds = React.useMemo(
    () =>
      new Set(
        (follows ?? [])
          .filter((f) => f.followerId === user?.id)
          .map((f) => f.followingId),
      ),
    [follows, user],
  )

  const feed = React.useMemo(() => {
    if (tab === 'following' && user) {
      return posts.filter(
        (p) => p.userId === user.id || followingIds.has(p.userId),
      )
    }
    return posts
  }, [posts, tab, user, followingIds])

  // Exact: the scoped collection records the server's `hasMore` from its
  // last fetch, so "Load more" hides precisely at the tail of the table.
  const hasMore = feedWindow.hasMore()

  if (feed.length === 0) {
    return (
      <article className="p-4">
        <p className="text-muted-foreground">
          {tab === 'following'
            ? 'Follow people to see their posts here.'
            : 'No posts yet. Run bun run seed or compose the first post.'}
        </p>
      </article>
    )
  }

  return (
    <div>
      {feed.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          author={authorMap.get(post.userId)}
          allPosts={posts}
          likes={likes ?? []}
          retweets={retweets ?? []}
          authorMap={authorMap}
          currentUserId={user?.id ?? null}
        />
      ))}
      <LoadMore
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={() => void loadMore()}
      />
    </div>
  )
}

function SuggestionsAside({ user }: { user: RouterContext['user'] }) {
  const { api } = Route.useRouteContext()

  const { data: users } = useLiveQuery((q) =>
    q.from({ user: api.user.collection }),
  )
  const { data: follows } = useLiveQuery((q) =>
    q.from({ follow: api.follows.collection }),
  )

  const followingIds = React.useMemo(
    () =>
      new Set(
        (follows ?? [])
          .filter((f) => f.followerId === user?.id)
          .map((f) => f.followingId),
      ),
    [follows, user],
  )

  const suggestions = React.useMemo(() => {
    const pool = users ?? []
    if (!user) return pool.slice(0, 3)
    return pool
      .filter((u) => u.id !== user.id && !followingIds.has(u.id))
      .slice(0, 3)
  }, [user, users, followingIds])

  if (suggestions.length === 0) return null

  return (
    <aside aria-label="Suggestions">
      <article className="rounded-lg border p-4">
        <h3 className="mb-3 font-semibold">Who to follow</h3>
        <ul className="space-y-3">
          {suggestions.map((person) => (
            <li key={person.id} className="flex items-center justify-between gap-2">
              <Link
                to="/users/$userId"
                params={{ userId: person.id }}
                className="flex min-w-0 items-center gap-2"
              >
                <UserAvatar name={person.name} image={person.image} size={40} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{person.name}</div>
                  <div className="text-muted-foreground truncate text-sm">
                    {person.email}
                  </div>
                </div>
              </Link>
              <FollowButton
                currentUserId={user?.id ?? null}
                targetUserId={person.id}
                follows={follows ?? []}
              />
            </li>
          ))}
        </ul>
      </article>
    </aside>
  )
}
