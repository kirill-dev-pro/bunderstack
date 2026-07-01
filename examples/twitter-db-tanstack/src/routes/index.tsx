import * as React from 'react'
import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { useLiveQuery, eq } from '@tanstack/react-db'

import { createFeedPostsCollection } from '~/collections'

export const Route = createFileRoute('/')({
  component: FeedPage,
})

function FeedPage() {
  return (
    <ClientOnly fallback={<div>Loading…</div>}>
      <FeedList />
    </ClientOnly>
  )
}

// useLiveQuery's useSyncExternalStore call has no getServerSnapshot arg — it
// cannot run during SSR (@tanstack/react-db@0.1.91). Isolated in its own
// component so the hook is never invoked server-side; ClientOnly only
// mounts children in the browser.
function FeedList() {
  const { api, queryClient } = Route.useRouteContext()
  const [desiredCount, setDesiredCount] = React.useState(20)

  // New collection instance each time desiredCount grows — its queryFn walks
  // cursor-paginated server pages (each ≤200 rows) up to desiredCount,
  // rather than a single list() call that the server would clamp at 200
  // regardless of what limit was requested.
  const feedPostsCollection = React.useMemo(
    () => createFeedPostsCollection(queryClient, api.posts.table, desiredCount),
    [queryClient, api.posts.table, desiredCount],
  )

  const { data: posts } = useLiveQuery((q) =>
    q
      .from({ post: feedPostsCollection })
      .join({ author: api.user.collection }, ({ post, author }) =>
        eq(author.id, post.userId),
      )
      .orderBy(({ post }) => post.createdAt, 'desc')
      .select(({ post, author }) => ({
        id: post.id,
        body: post.body,
        createdAt: post.createdAt,
        authorName: author.name,
      })),
  )

  return (
    <div>
      {(posts ?? []).map((p) => (
        <article key={p.id}>
          <strong>{p.authorName}</strong>
          <p>{p.body}</p>
        </article>
      ))}
      <button type="button" onClick={() => setDesiredCount((n) => n + 20)}>
        Load more
      </button>
    </div>
  )
}
