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
    <div className="min-h-screen bg-[#F6F3E9] text-[#17211B] flex flex-col items-center justify-center p-6 text-center">
      <h1 className="font-display text-4xl font-bold mb-2">
        404 — Page Not Found
      </h1>
      <p className="text-[#17211B]/70 max-w-md mb-6">
        The requested page was not found on BunderSaaS.
      </p>
      <Link
        to="/"
        className="px-4 py-2 bg-[#17211B] text-[#FFFDF7] rounded-[10px] text-sm font-medium hover:bg-[#17211B]/90 transition-colors"
      >
        Return to Home
      </Link>
    </div>
  )
}

function ErrorComponent({ error }: { error: Error }) {
  return (
    <div className="min-h-screen bg-[#F6F3E9] text-[#17211B] flex flex-col items-center justify-center p-6 text-center">
      <h1 className="font-display text-3xl font-bold mb-2 text-red-700">
        An Error Occurred
      </h1>
      <p className="text-[#17211B]/80 font-mono text-xs max-w-md p-4 bg-white/60 rounded-[10px] border border-red-200 mb-6 overflow-x-auto">
        {error.message || 'Unexpected application error.'}
      </p>
      <Link
        to="/"
        className="px-4 py-2 bg-[#17211B] text-[#FFFDF7] rounded-[10px] text-sm font-medium hover:bg-[#17211B]/90 transition-colors"
      >
        Back to Safety
      </Link>
    </div>
  )
}
