import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getSessionUser } from 'bunderstack-start'
import { asTypeId } from 'bunderstack/typeid'

import { app } from '~/bunderstack'

export const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  if (!request) return null
  const user = await getSessionUser(app, request)
  if (!user) return null

  try {
    return {
      id: asTypeId('user', user.id),
      email: user.email,
      name: user.name,
      image: user.image,
    }
  } catch {
    // Stale session from before TypeID migration — treat as logged out.
    return null
  }
})
