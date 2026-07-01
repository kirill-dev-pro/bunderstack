import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import type { TypeId } from 'bunderstack/typeid'

import { createApi, createQueryClient, type SyncApi } from './api'
import { DefaultCatchBoundary } from './components/DefaultCatchBoundary'
import { NotFound } from './components/NotFound'
import { routeTree } from './routeTree.gen'

export type RouterContext = {
  queryClient: QueryClient
  api: SyncApi
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

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
