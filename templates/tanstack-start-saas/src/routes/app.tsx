import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { AppShell } from '~/components/app-shell'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/login' })
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
  const { user } = Route.useRouteContext()
  return (
    <AppShell user={user}>
      <Outlet />
    </AppShell>
  )
}
