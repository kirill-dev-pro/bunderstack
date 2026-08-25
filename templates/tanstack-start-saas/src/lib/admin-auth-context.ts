import type { SessionUser } from 'bunderstack/start'

import { redirect } from '@tanstack/react-router'

export type AdminAuthContext = {
  user: SessionUser
  role: 'admin'
  isAdmin: true
}

/**
 * Route context helper for admin portal authentication.
 * Performs session and role checks, throwing redirects to /login or /app.
 */
export function requireAdminAuth({
  context,
  location,
}: {
  context: { user: SessionUser | null }
  location: { href: string }
}): { adminAuth: AdminAuthContext } {
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
      role: 'admin',
      isAdmin: true,
    },
  }
}
