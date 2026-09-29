import { createServerFn } from '@tanstack/react-start'
import { createIsomorphicFetch } from 'bunderstack/start'

const isoFetch = createIsomorphicFetch()

/** The signed-in user, read on the server with the request's cookie. */
export const getUser = createServerFn({ method: 'GET' }).handler(async () => {
  const res = await isoFetch('/api/auth/get-session')
  const session = (await res.json().catch(() => null)) as {
    user?: { email: string }
  } | null
  return session?.user ? { email: session.user.email } : null
})
