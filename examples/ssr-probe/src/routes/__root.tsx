import { QueryClientProvider } from '@tanstack/react-query'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'

import { queryClient } from '../api'
import { getUser } from '../session'

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await getUser() }),
  head: () => ({ meta: [{ charSet: 'utf-8' }, { title: 'SSR probe' }] }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  ),
})
