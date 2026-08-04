import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getSessionUser, type SessionUser } from 'bunderstack-start'

import { app } from '~/bunderstack'

/**
 * Isomorphic server function to fetch the current authenticated user.
 */
export const fetchUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionUser | null> => {
    const request = getRequest()
    if (!request) return null
    return await getSessionUser(app, request)
  },
)

/**
 * Isomorphic server function to verify client authentication context.
 */
export const fetchClientSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ user: SessionUser } | null> => {
    const request = getRequest()
    if (!request) return null
    const user = await getSessionUser(app, request)
    if (!user) return null
    return { user }
  },
)

/**
 * Isomorphic server function to verify admin authentication context.
 */
export const fetchAdminSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ user: SessionUser; isAdmin: boolean } | null> => {
    const request = getRequest()
    if (!request) return null
    const user = await getSessionUser(app, request)
    if (!user || user.role !== 'admin') return null
    return { user, isAdmin: true }
  },
)
