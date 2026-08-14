import { useQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import * as React from 'react'

import { UserAvatar } from '~/components/UserAvatar'

const SEARCH_LIST_PARAMS = { limit: 100, offset: 0 } as const

type SearchBoxProps = {
  className?: string
}

export function SearchBox({ className }: SearchBoxProps) {
  const { api, queryClient } = useRouteContext({ from: '__root__' })
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const term = q.trim()

  const { data: postsData, isFetching: postsFetching } = useQuery(
    {
      queryKey: ['posts', 'search', term],
      queryFn: () => api.posts.table.list({ ...SEARCH_LIST_PARAMS, q: term }),
      enabled: term.length >= 2,
    },
    queryClient,
  )
  const { data: usersData, isFetching: usersFetching } = useQuery(
    {
      queryKey: ['user', 'search', term],
      queryFn: () => api.user.table.list({ ...SEARCH_LIST_PARAMS, q: term }),
      enabled: term.length >= 2,
    },
    queryClient,
  )

  const posts = postsData?.items ?? []
  const users = usersData?.items ?? []
  const hasResults = term.length >= 2 && (posts.length > 0 || users.length > 0)
  const loading = postsFetching || usersFetching

  return (
    <div className={`relative ${className ?? ''}`}>
      <label className="block">
        <span className="sr-only">Search</span>
        <input
          type="search"
          placeholder="Search posts & people"
          className="w-full rounded-full border border-input bg-transparent px-4 py-2 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </label>

      {open && term.length >= 2 ? (
        <div
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-96 overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
          role="listbox"
        >
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Searching…</p>
          ) : null}
          {!loading && !hasResults ? (
            <p className="p-2 text-sm text-muted-foreground">
              No results for “{term}”
            </p>
          ) : null}

          {users.length > 0 ? (
            <section>
              <h4 className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase">
                People
              </h4>
              <ul>
                {users.map((person) => (
                  <li key={person.id}>
                    <Link
                      to="/users/$userId"
                      params={{ userId: person.id }}
                      className="flex items-center gap-2 rounded-md p-2 hover:bg-accent"
                      onClick={() => setOpen(false)}
                    >
                      <UserAvatar
                        name={person.name}
                        image={person.image}
                        size={32}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-semibold">
                          {person.name}
                        </div>
                        {person.about ? (
                          <div className="truncate text-sm text-muted-foreground">
                            {person.about}
                          </div>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {posts.length > 0 ? (
            <section>
              <h4 className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase">
                Posts
              </h4>
              <ul>
                {posts.map((post) => (
                  <li key={post.id} className="rounded-md p-2">
                    <div className="font-semibold">{post.title}</div>
                    <div className="truncate text-sm text-muted-foreground">
                      {post.body.slice(0, 120)}
                      {post.body.length > 120 ? '…' : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
