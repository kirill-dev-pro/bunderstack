import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'

import { createApi, createQueryClient, type AppApi } from './api'
import { DefaultCatchBoundary } from './components/DefaultCatchBoundary'
import { NotFound } from './components/NotFound'
import { routeTree } from './routeTree.gen'
import type { AuthUser } from './utils/session'

export type RouterContext = {
  queryClient: QueryClient
  api: AppApi
  user: AuthUser | null
}

export function getRouter() {
  const queryClient = createQueryClient()
  const api = createApi(queryClient)

  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      api,
      user: null,
    } satisfies RouterContext,
    defaultPreload: 'intent',
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  })
  return router
}
