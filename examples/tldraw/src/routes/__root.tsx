/// <reference types="vite/client" />
import { QueryClientProvider } from '@tanstack/react-query'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import * as React from 'react'
import { Toaster } from 'sonner'

import type { RouterContext } from '~/router'

import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import appCss from '~/styles/app.css?url'
import { fetchUser } from '~/utils/session'

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
                <Link
                  to="/canvas"
                  activeProps={{
                    className: 'font-bold text-blue-600',
                  }}
                >
                  Canvases
                </Link>
                <Link
                  to="/login"
                  activeProps={{
                    className: 'font-bold text-blue-600',
                  }}
                >
                  Login
                </Link>
              </nav>
              {user ? (
                <span className="truncate text-sm text-slate-500 dark:text-slate-400">
                  {user.email}
                </span>
              ) : null}
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
