/// <reference types="vite/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { createServerFn } from '@tanstack/react-start'
import * as React from 'react'
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import appCss from '~/styles/app.css?url'
import { seo } from '~/utils/seo'
import { getAuthSession } from '~/utils/session'

const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await getAuthSession()
  return session?.user ? { id: session.user.id, email: session.user.email, name: session.user.name } : null
})

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await fetchUser() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...seo({ title: 'Bunderstack + TanStack Start', description: 'Full-stack auth + CRUD powered by Bunderstack' }),
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: (props) => (
    <RootDocument>
      <DefaultCatchBoundary {...props} />
    </RootDocument>
  ),
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
  const { user } = Route.useRouteContext()

  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="p-2 flex gap-2 text-lg items-center">
          <Link to="/" activeProps={{ className: 'font-bold' }} activeOptions={{ exact: true }}>
            Home
          </Link>
          <Link to="/posts" activeProps={{ className: 'font-bold' }}>
            Posts
          </Link>
          <div className="ml-auto flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-gray-500">{user.email}</span>
                <Link to="/logout" className="text-sm">Logout</Link>
              </>
            ) : (
              <>
                <Link to="/login" className="text-sm">Login</Link>
                <Link to="/signup" className="text-sm font-semibold">Sign up</Link>
              </>
            )}
          </div>
        </div>
        <hr />
        {children}
        <TanStackRouterDevtools position="bottom-right" />
        <Scripts />
      </body>
    </html>
  )
}
