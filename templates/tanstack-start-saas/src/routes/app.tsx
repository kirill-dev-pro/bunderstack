import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { AppShell } from '~/components/app-shell'
import { fetchClientSession } from '~/lib/session'

export const Route = createFileRoute('/app')({
  beforeLoad: async () => {
    // Isomorphic server function call to fetch user session and verify client access
    const session = await fetchClientSession()
    if (!session?.user) {
      throw redirect({ to: '/login' })
    }
    return {
      clientAuth: {
        user: session.user,
        role: 'client' as const,
      },
    }
  },
  component: ClientAppLayout,
})

function ClientAppLayout() {
  const { clientAuth } = Route.useRouteContext()
  return (
    <AppShell user={clientAuth.user}>
      <Outlet />
    </AppShell>
  )
}
