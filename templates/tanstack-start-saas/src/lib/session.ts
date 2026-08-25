import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getSessionUser, type SessionUser } from 'bunderstack/start'

import { app } from '~/bunderstack'

/**
 * Isomorphic server function to fetch the current authenticated user session.
 */
export const fetchUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionUser | null> => {
    const request = getRequest()
    if (!request) return null
    return await getSessionUser(app, request)
  },
)
