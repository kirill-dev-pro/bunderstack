import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AppShell } from '~/components/app-shell'
import { requireClientAuth } from '~/lib/client-auth-context'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context, location }) => requireClientAuth({ context, location }),
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
