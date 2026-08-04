import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import * as React from 'react'
import { AppShell } from '~/components/app-shell'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/login' })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const { user } = Route.useRouteContext()
  return (
    <AppShell user={user}>
      <Outlet />
    </AppShell>
  )
}
