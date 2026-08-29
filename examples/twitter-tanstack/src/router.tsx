import type { TypeId } from 'bunderstack/typeid'

import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'

import { createApi, createQueryClient, type AppApi } from './api-client'
import { DefaultCatchBoundary } from './components/DefaultCatchBoundary'
import { NotFound } from './components/NotFound'
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

    // The loaders fill the query cache on the server. Without handing that
    // cache to the client, hydration starts from an empty one: the client
    // renders the empty state over server-rendered content, React reports a
    // mismatch, and every list refetches on first paint. The state travels as
    // a JSON string because the router's serializability check rejects the
    // `unknown[]` query keys inside DehydratedState.
    dehydrate: () => ({ queryState: JSON.stringify(dehydrate(queryClient)) }),
    hydrate: (dehydrated: { queryState: string }) => {
      hydrate(queryClient, JSON.parse(dehydrated.queryState))
    },
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
