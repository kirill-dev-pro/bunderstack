import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import type { SessionUser } from 'bunderstack-start'

import { connectRealtime, createApi, createQueryClient, type SyncApi } from './api'
import { routeTree } from './routeTree.gen'

export type RouterContext = {
  queryClient: QueryClient
  api: SyncApi
  user: SessionUser | null
}

export function getRouter() {
  const queryClient = createQueryClient()
  const api = createApi(queryClient)
  connectRealtime(api, queryClient)

  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      api,
      user: null,
    } satisfies RouterContext,
    defaultPreload: 'intent',
    scrollRestoration: true,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
