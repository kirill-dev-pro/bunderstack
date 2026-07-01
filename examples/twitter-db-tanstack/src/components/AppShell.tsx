import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'
import type { TypeId } from 'bunderstack/typeid'

import { SearchBox } from '~/components/SearchBox'
import { UserAvatar } from '~/components/UserAvatar'
import { Button } from '~/components/ui/button'

type AppShellProps = {
  user: {
    id: TypeId<'user'>
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
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <header className="sticky top-0 z-10 border-b bg-background">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3"
        >
          <Link
            to="/"
            search={{ tab: 'for-you' }}
            className="text-lg font-bold"
          >
            Bunder
          </Link>
          <SearchBox className="max-w-sm flex-1" />
          {user ? (
            <div className="flex items-center gap-3">
              {onCompose ? (
                <Button type="button" size="sm" onClick={onCompose}>
                  Post
                </Button>
              ) : null}
              <Link
                to="/users/$userId"
                params={{ userId: user.id }}
                className="hover:underline"
              >
                Profile
              </Link>
              <Link to="/profile" className="hover:underline">
                Settings
              </Link>
              <div className="flex items-center gap-2">
                <UserAvatar name={user.name} image={user.image} size={32} />
                <Link to="/logout" className="hover:underline">
                  Log out
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Link to="/login" className="hover:underline">
                Log in
              </Link>
              <Link to="/signup" className="hover:underline">
                Sign up
              </Link>
            </div>
          )}
        </nav>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 gap-6 px-4 py-6">
        <main className="min-w-0 flex-1 border-x">{children}</main>
        {aside ?? (
          <aside className="hidden w-72 shrink-0 md:block">
            <article className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">Demo</h3>
              <p className="text-muted-foreground text-sm">
                <code>bun run seed</code> — alice@example.com / password123
              </p>
            </article>
          </aside>
        )}
      </div>
    </div>
  )
}
