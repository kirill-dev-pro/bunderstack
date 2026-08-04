import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { AdminAppShell } from '~/components/admin-shell'

export const Route = createFileRoute('/admin')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      })
    }
    if (context.user.role !== 'admin') {
      throw redirect({ to: '/app' })
    }
    return {
      adminAuth: {
        user: context.user,
        role: 'admin' as const,
        isAdmin: true,
      },
    }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { adminAuth } = Route.useRouteContext()
  return (
    <AdminAppShell user={adminAuth.user}>
      <Outlet />
    </AdminAppShell>
  )
}
