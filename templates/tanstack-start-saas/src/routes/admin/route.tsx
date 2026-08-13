import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AdminAppShell } from '~/components/admin-shell'
import { requireAdminAuth } from '~/lib/admin-auth-context'

export const Route = createFileRoute('/admin')({
  beforeLoad: ({ context, location }) => requireAdminAuth({ context, location }),
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
