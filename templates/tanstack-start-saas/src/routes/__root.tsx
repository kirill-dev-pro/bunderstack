import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import * as React from 'react'

import type { RouterContext } from '~/router'

import { fetchUser } from '~/lib/session'
import appCss from '~/styles.css?url'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => ({
    user: await fetchUser(),
  }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'BunderSaaS Platform' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&display=swap',
      },
    ],
  }),
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
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
        <Scripts />
      </body>
    </html>
  )
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F6F3E9] p-6 text-center text-[#17211B]">
      <h1 className="font-display mb-2 text-4xl font-bold">
        404 — Page Not Found
      </h1>
      <p className="mb-6 max-w-md text-[#17211B]/70">
        The requested page was not found on BunderSaaS.
      </p>
      <Link
        to="/"
        className="rounded-[10px] bg-[#17211B] px-4 py-2 text-sm font-medium text-[#FFFDF7] transition-colors hover:bg-[#17211B]/90"
      >
        Return to Home
      </Link>
    </div>
  )
}

function ErrorComponent({ error }: { error: Error }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F6F3E9] p-6 text-center text-[#17211B]">
      <h1 className="font-display mb-2 text-3xl font-bold text-red-700">
        An Error Occurred
      </h1>
      <p className="mb-6 max-w-md overflow-x-auto rounded-[10px] border border-red-200 bg-white/60 p-4 font-mono text-xs text-[#17211B]/80">
        {error.message || 'Unexpected application error.'}
      </p>
      <Link
        to="/"
        className="rounded-[10px] bg-[#17211B] px-4 py-2 text-sm font-medium text-[#FFFDF7] transition-colors hover:bg-[#17211B]/90"
      >
        Back to Safety
      </Link>
    </div>
  )
}
