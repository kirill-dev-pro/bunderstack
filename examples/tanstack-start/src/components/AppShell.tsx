import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'

import { SearchBox } from '~/components/SearchBox'
import { UserAvatar } from '~/components/UserAvatar'

type AppShellProps = {
  user: {
    id: string
    email: string
    name: string
    image?: string | null
  } | null
  children: ReactNode
  aside?: ReactNode
  onCompose?: () => void
}

export function AppShell({ user, children, aside, onCompose }: AppShellProps) {
  return (
    <div className="app-layout">
      <header className="app-header">
        <nav aria-label="Main" className="app-nav">
          <Link to="/" className="app-brand">
            Bunder
          </Link>
          <SearchBox />
          {user ? (
            <>
              {onCompose ? (
                <button type="button" onClick={onCompose}>
                  Post
                </button>
              ) : null}
              <Link to="/users/$userId" params={{ userId: user.id }}>
                Profile
              </Link>
              <Link to="/profile">Settings</Link>
              <div className="app-nav-user">
                <UserAvatar name={user.name} image={user.image} size={32} />
                <Link to="/logout">Log out</Link>
              </div>
            </>
          ) : (
            <>
              <Link to="/login">Log in</Link>
              <Link to="/signup">Sign up</Link>
            </>
          )}
        </nav>
      </header>

      <div className="app-body">
        <main className="app-main">{children}</main>
        {aside ?? (
          <aside className="app-aside">
            <article className="card">
              <header>
                <h3>Demo</h3>
              </header>
              <p>
                <code>bun run seed</code> — alice@example.com / password123
              </p>
            </article>
          </aside>
        )}
      </div>
    </div>
  )
}
