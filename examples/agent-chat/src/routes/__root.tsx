import type { ReactNode } from 'react'

import { QueryClientProvider } from '@tanstack/react-query'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'

import type { RouterContext } from '~/router'

import stylesCss from '~/styles.css?url'
import { fetchUser } from '~/utils/session'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => ({ user: await fetchUser() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Agent Desk · Bunderstack' },
    ],
    links: [
      { rel: 'stylesheet', href: stylesCss },
      // Inline, so browsers stop asking for a /favicon.ico the app never had.
      {
        rel: 'icon',
        href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💬</text></svg>",
      },
    ],
  }),
  notFoundComponent: () => (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">404 / NO ROUTE</p>
        <h1>This path is outside the agent’s desk.</h1>
      </section>
    </main>
  ),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  const { queryClient } = Route.useRouteContext()
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
