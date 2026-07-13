import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { asTypeId } from 'bunderstack/typeid'

import { app } from '~/bunderstack'

export const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  if (!request) return null
  const session = await app.auth.api.getSession({ headers: request.headers })

  if (!session?.user) return null

  return {
    id: asTypeId('user', session.user.id),
    email: session.user.email,
    name: session.user.name,
    image: session.user.image,
  }
})
