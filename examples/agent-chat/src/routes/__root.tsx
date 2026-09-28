import { QueryClientProvider } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'

import type { RouterContext } from '~/router'

import { fetchUser } from '~/utils/session'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => ({ user: await fetchUser() }),
  notFoundComponent: () => (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">404 / NO ROUTE</p>
        <h1>This path is outside the agent’s desk.</h1>
      </section>
    </main>
  ),
  component: RootComponent,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  )
}
