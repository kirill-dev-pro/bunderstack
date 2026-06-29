import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { api, listParams } from '~/api-client'
import { UserAvatar } from '~/components/UserAvatar'

type SearchBoxProps = {
  className?: string
}

export function SearchBox({ className }: SearchBoxProps) {
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const term = q.trim()

  const { data: postsData, isFetching: postsFetching } = useQuery({
    ...api.posts.listQuery({ ...listParams, q: term }),
    enabled: term.length >= 2,
  })
  const { data: usersData, isFetching: usersFetching } = useQuery({
    ...api.user.listQuery({ ...listParams, q: term }),
    enabled: term.length >= 2,
  })

  const posts = postsData?.items ?? []
  const users = usersData?.items ?? []
  const hasResults = term.length >= 2 && (posts.length > 0 || users.length > 0)
  const loading = postsFetching || usersFetching

  return (
    <div className={`search-box ${className ?? ''}`}>
      <label className="search-label">
        <span className="sr-only">Search</span>
        <input
          type="search"
          placeholder="Search posts & people"
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
        <div className="search-results card" role="listbox">
          {loading ? (
            <p>
              <small>Searching…</small>
            </p>
          ) : null}
          {!loading && !hasResults ? (
            <p>
              <small>No results for “{term}”</small>
            </p>
          ) : null}

          {users.length > 0 ? (
            <section>
              <h4>People</h4>
              <ul>
                {users.map((person) => (
                  <li key={person.id}>
                    <Link
                      to="/users/$userId"
                      params={{ userId: person.id }}
                      className="search-hit"
                      onClick={() => setOpen(false)}
                    >
                      <UserAvatar
                        name={person.name}
                        image={person.image}
                        size={32}
                      />
                      <div>
                        <strong>{person.name}</strong>
                        {person.about ? <small>{person.about}</small> : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {posts.length > 0 ? (
            <section>
              <h4>Posts</h4>
              <ul>
                {posts.map((post) => (
                  <li key={post.id}>
                    <div className="search-hit">
                      <strong>{post.title}</strong>
                      <small>
                        {post.body.slice(0, 120)}
                        {post.body.length > 120 ? '…' : ''}
                      </small>
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
