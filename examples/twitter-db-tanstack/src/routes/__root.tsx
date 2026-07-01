import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  ClientOnly,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { asTypeId } from 'bunderstack/typeid'
import * as React from 'react'

import type { RouterContext } from '~/router'

import { AppDevtools } from '~/components/AppDevtools'
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import { Toaster } from '~/components/ui/sonner'
import appCss from '~/styles/app.css?url'
import { seo } from '~/utils/seo'
import { fetchUser } from '~/utils/session'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => ({ user: await fetchUser() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...seo({
        title: 'Bunder',
        description: 'Twitter-style demo on Bunderstack + TanStack Start',
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
        {children}
        <Toaster />
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
