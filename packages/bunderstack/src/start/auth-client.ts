import { createAuthClient } from 'better-auth/react'
import { createManagedAuthClient } from 'workerstack/managed-auth/client'

/**
 * BetterAuth browser client pointed at the Bunderstack handler's
 * /api/auth/* routes. Defaults to the current origin in the browser and
 * APP_URL (or localhost:3000) during SSR.
 */
export type StartAuthClient = ReturnType<typeof createAuthClient> & {
  managed: {
    providers: ReturnType<typeof createManagedAuthClient>['providers']
  }
  signIn: ReturnType<typeof createAuthClient>['signIn'] & {
    managed: ReturnType<typeof createManagedAuthClient>['signIn']
  }
}
export function createStartAuthClient(
  options: { baseURL?: string } = {},
): StartAuthClient {
  const baseURL =
    options.baseURL ??
    (typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.APP_URL ?? 'http://localhost:3000'))
  const managed = createManagedAuthClient(baseURL)
  return createAuthClient({
    baseURL,
    plugins: [
      {
        id: 'bunderhost-managed-client',
        getActions: () => ({
          managed: { providers: managed.providers },
          signIn: { managed: managed.signIn },
        }),
      },
    ],
  }) as StartAuthClient
}
