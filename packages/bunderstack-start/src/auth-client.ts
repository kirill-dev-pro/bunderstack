import { createAuthClient } from 'better-auth/react'

/**
 * BetterAuth browser client pointed at the Bunderstack handler's
 * /api/auth/* routes. Defaults to the current origin in the browser and
 * APP_URL (or localhost:3000) during SSR.
 */
export function createStartAuthClient(options: { baseURL?: string } = {}) {
  return createAuthClient({
    baseURL:
      options.baseURL ??
      (typeof window !== 'undefined'
        ? window.location.origin
        : (process.env.APP_URL ?? 'http://localhost:3000')),
  })
}
