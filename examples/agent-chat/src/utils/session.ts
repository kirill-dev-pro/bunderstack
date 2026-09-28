import { asTypeId } from 'bunderstack/typeid'

import { authClient } from '~/utils/auth-client'

/** The signed-in user, from the Better Auth session cookie. */
export async function fetchUser() {
  const { data } = await authClient.getSession()
  if (!data?.user) return null
  return {
    id: asTypeId('user', data.user.id),
    email: data.user.email,
    name: data.user.name,
    image: data.user.image,
    // Added to the user by the anonymous plugin.
    isAnonymous: data.user.isAnonymous ?? false,
  }
}
