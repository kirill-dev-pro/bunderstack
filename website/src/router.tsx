import { createRouter } from '@tanstack/react-router'

import { NotFound } from './components/not-found'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const basepath = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

  return createRouter({
    routeTree,
    basepath,
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
