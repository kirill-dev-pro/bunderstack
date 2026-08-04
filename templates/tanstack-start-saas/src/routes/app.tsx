import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { AppShell } from '~/components/app-shell'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      })
    }
    return {
      clientAuth: {
        user: context.user,
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
