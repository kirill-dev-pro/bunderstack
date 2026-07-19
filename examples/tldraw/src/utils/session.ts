// @ts-nocheck

import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getSessionUser } from 'bunderstack-start'
import { asTypeId, type TypeId } from 'bunderstack/typeid'

import { app } from '~/bunderstack'

export type AuthUser = {
  id: TypeId<'user'>
  email: string
  name: string
  image?: string | null
}

type SessionLike = {
  user?: {
    id: string
    email: string
    name: string
    image?: string | null
  } | null
} | null

export function normalizeSessionUser(session: SessionLike): AuthUser | null {
  if (!session?.user) return null

  try {
    return {
      id: asTypeId('user', session.user.id),
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
    }
  } catch {
    return null
  }
}

export const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  if (!request) return null

  const user = await getSessionUser(app, request)
  return normalizeSessionUser(user ? { user } : null)
})
