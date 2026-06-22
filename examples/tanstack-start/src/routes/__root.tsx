/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute, ClientOnly } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import * as React from 'react'
import { queryClient } from '~/api-client'
import { AppDevtools } from '~/components/AppDevtools'
import { OatInit } from '~/components/OatInit'
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import appCss from '~/styles/app.css?url'
import { seo } from '~/utils/seo'
import { getAuthSession } from '~/utils/session'

const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await getAuthSession()
  return session?.user
    ? { id: session.user.id, email: session.user.email, name: session.user.name, image: session.user.image }
    : null
})

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await fetchUser() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...seo({ title: 'Bunder', description: 'Twitter-style demo on Bunderstack + TanStack Start' }),
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
