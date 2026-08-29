import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { asTypeId } from 'bunderstack/typeid'
import { eq } from 'drizzle-orm'

import { app } from '~/bunderstack'
import { user } from '~/schema'

export const fetchUser = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  if (!request) return null
  const session = await app.auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  const userId = asTypeId('user', session.user.id)
  const persistedUser = await app.db
    .select({ isAnonymous: user.isAnonymous })
    .from(user)
    .where(eq(user.id, userId))
    .get()
  return {
    id: userId,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image,
    isAnonymous: persistedUser?.isAnonymous ?? false,
  }
})
