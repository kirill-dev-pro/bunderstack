import type { SessionUser } from 'bunderstack/start'

import { redirect } from '@tanstack/react-router'

export type ClientAuthContext = {
  user: SessionUser
  role: 'client'
}

/**
 * Route context helper for client workspace authentication.
 * Performs session check and returns typed clientAuth context.
 */
export function requireClientAuth({
  context,
  location,
}: {
  context: { user: SessionUser | null }
  location: { href: string }
}): { clientAuth: ClientAuthContext } {
  if (!context.user) {
    throw redirect({
      to: '/login',
      search: { redirect: location.href },
    })
  }

  return {
    clientAuth: {
      user: context.user,
      role: 'client',
    },
  }
}
