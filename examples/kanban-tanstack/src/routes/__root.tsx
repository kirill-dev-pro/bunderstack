import { QueryClientProvider } from '@tanstack/react-query'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  ClientOnly,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import * as React from 'react'

import { queryClient } from '~/api-client'
import { AppDevtools } from '~/components/AppDevtools'
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import { OatInit } from '~/components/OatInit'
import appCss from '~/styles/app.css?url'
import { seo } from '~/utils/seo'
import { getAuthSession, ensureActiveOrganization } from '~/utils/session'

const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureActiveOrganization()
  const session = await getAuthSession()
  return session?.user
    ? {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
      }
    : null
})

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await fetchUser() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...seo({
        title: 'Kanban',
        description:
          'Org-scoped kanban boards with realtime updates on Bunderstack',
      }),
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
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <ClientOnly>
          <OatInit />
        </ClientOnly>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
        {import.meta.env.DEV ? (
          <ClientOnly>
            <AppDevtools />
          </ClientOnly>
        ) : null}
        <Scripts />
      </body>
    </html>
  )
}
