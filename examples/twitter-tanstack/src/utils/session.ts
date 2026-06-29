import { getRequest } from '@tanstack/react-start/server'

import { app } from '~/bunderstack'

// Returns BetterAuth session or null — call only inside createServerFn handlers.
export async function getAuthSession() {
  const request = getRequest()
  if (!request) return null
  return app.auth.api.getSession({ headers: request.headers })
}
