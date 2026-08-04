import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { AdminAppShell } from '~/components/admin-shell'
import { fetchAdminSession, fetchUser } from '~/lib/session'

export const Route = createFileRoute('/admin')({
  beforeLoad: async () => {
    // Isomorphic server function call to fetch user session and verify admin role
    const session = await fetchAdminSession()
    if (!session?.user || !session.isAdmin) {
      // Isomorphically check if user is logged in at all to decide redirect target
      const currentUser = await fetchUser()
      if (currentUser) {
        throw redirect({ to: '/app' })
      }
      throw redirect({ to: '/login' })
    }
    return {
      adminAuth: {
        user: session.user,
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
