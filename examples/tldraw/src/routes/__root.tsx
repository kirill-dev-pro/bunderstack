/// <reference types="vite/client" />
import { QueryClientProvider, useMutation } from '@tanstack/react-query'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import * as React from 'react'
import { Toaster } from 'sonner'

import type { RouterContext } from '~/router'

import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import appCss from '~/styles/app.css?url'
import { authClient } from '~/utils/auth-client'
import { fetchUser } from '~/utils/session'
import { getUserInitials, getUserLabel } from '~/utils/user-menu'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => ({ user: await fetchUser() }),
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'TLDraw | A Bunderstack Example',
        description: `TLDraw-like collaborative drawing app built with Bunderstack.`,
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const { queryClient, user } = Route.useRouteContext()

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        <QueryClientProvider client={queryClient}>
          <div className="flex min-h-screen flex-col">
            <header className="flex items-center justify-between gap-4 border-b bg-white/90 px-4 py-3 text-slate-900 shadow-sm dark:bg-gray-950 dark:text-gray-100">
              <nav className="flex gap-3 text-sm font-medium">
                <Link
                  to="/"
                  activeProps={{
                    className: 'font-bold text-blue-600',
                  }}
                  activeOptions={{ exact: true }}
                >
                  Home
                </Link>
                {user ? (
                  <Link
                    to="/canvas"
                    activeProps={{
                      className: 'font-bold text-blue-600',
                    }}
                  >
                    Canvases
                  </Link>
                ) : null}
              </nav>
              <AccountNav user={user} />
            </header>
            <main className="min-h-0 flex-1">{children}</main>
          </div>
          <Toaster />
          <TanStackRouterDevtools position="bottom-right" />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

function AccountNav({
  user,
}: {
  user: RouterContext['user']
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const logoutMutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut()
      if (error) throw new Error(error.message ?? 'Logout failed')
    },
    onSuccess: async () => {
      setOpen(false)
      await router.invalidate()
      await router.navigate({ to: '/', replace: true })
    },
  })

  if (!user) {
    return (
      <Link
        to="/login"
        activeProps={{ className: 'font-bold text-blue-600' }}
        className="rounded-full border px-4 py-2 text-sm font-semibold transition hover:border-blue-300 hover:text-blue-600"
      >
        Log in
      </Link>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-full border bg-white px-2 py-1 pr-3 text-sm font-semibold shadow-sm transition hover:border-blue-300 dark:bg-gray-900"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="grid size-8 place-items-center rounded-full bg-slate-950 text-xs font-black text-white">
          {getUserInitials(user)}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">
          {getUserLabel(user)}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-2xl border bg-white p-2 shadow-xl dark:bg-gray-950"
        >
          <div className="border-b px-3 py-2">
            <p className="truncate text-sm font-bold">{getUserLabel(user)}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
          </div>
          <Link
            to="/canvas"
            className="mt-2 block rounded-xl px-3 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-gray-900"
            onClick={() => setOpen(false)}
          >
            Your canvases
          </Link>
          <button
            type="button"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60 dark:hover:bg-red-950/30"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate()}
          >
            {logoutMutation.isPending ? 'Logging out...' : 'Log out'}
          </button>
          {logoutMutation.error ? (
            <p className="px-3 py-2 text-xs text-red-600">
              {logoutMutation.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
