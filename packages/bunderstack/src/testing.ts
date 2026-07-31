// src/testing.ts — test utilities for Bunderstack applications.

export type AuthSessionResolverLike = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<unknown>
  }
}

export type BunderstackAppLike = {
  auth: unknown
}

/**
 * Mock the auth session resolver on a Bunderstack app instance for unit testing.
 */
export function mockAuthSession<
  TUser extends { id: string; email: string; name?: string; role?: string },
>(
  app: BunderstackAppLike,
  resolver: (opts: { headers: Headers }) => Promise<{
    user: TUser
    session?: { activeOrganizationId?: string | null } | null
  } | null>,
): void {
  const auth = app.auth as unknown as AuthSessionResolverLike
  if (auth?.api) {
    auth.api.getSession = resolver as unknown as (opts: {
      headers: Headers
    }) => Promise<unknown>
  }
}
