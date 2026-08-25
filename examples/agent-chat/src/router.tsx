import type { TypeId } from 'bunderstack/typeid'

import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { syncRealtime } from 'bunderstack/query'

import { createApi, createQueryClient, type AppApi } from './api-client'
import { routeTree } from './routeTree.gen'

export type RouterContext = {
  queryClient: QueryClient
  api: AppApi
  user: {
    id: TypeId<'user'>
    email: string
    name: string
    image?: string | null
  } | null
}

export function getRouter() {
  const queryClient = createQueryClient()
  const api = createApi(queryClient)

  if (typeof document !== 'undefined') {
    syncRealtime({
      api,
      queryClient,
      tables: [
        'agentThreads',
        'agentMessages',
        'agentRuns',
        'agentToolCalls',
        'agentCommitments',
        'tasks',
      ],
    })
  }

  const router = createRouter({
    routeTree,
    context: { queryClient, api, user: null } satisfies RouterContext,
    defaultPreload: 'intent',
    scrollRestoration: true,
  })

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    wrapQueryClient: false,
  })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
