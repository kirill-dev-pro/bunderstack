import { test, expect } from 'bun:test'

import { resolveAccessUser } from './access'
import { toAuthSessionResolver } from './auth'

// A fake shaped like a better-auth instance's getSession result. Cast because
// the real parameter type is the full Auth instance.
const fakeAuth = (session: unknown) =>
  ({ api: { getSession: async () => session } }) as unknown as Parameters<
    typeof toAuthSessionResolver
  >[0]

test('maps a bare better-auth session to the resolver shape', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: {
        id: 'u1',
        email: 'a@b.c',
        name: 'Ann',
        emailVerified: true,
      },
      session: { activeOrganizationId: 'org1' },
    }),
  )
  const r = await resolver.api.getSession({ headers: new Headers() })
  expect(r).toEqual({
    user: {
      id: 'u1',
      email: 'a@b.c',
      name: 'Ann',
      emailVerified: true,
    },
    session: { activeOrganizationId: 'org1' },
  })
})

test('normalizes missing email verification to false', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: { id: 'u1', email: 'a@b.c', name: 'Ann' },
      session: {},
    }),
  )

  const result = await resolver.api.getSession({ headers: new Headers() })

  expect(result?.user?.emailVerified).toBe(false)
})

test('preserves false email verification', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: {
        id: 'u1',
        email: 'a@b.c',
        name: 'Ann',
        emailVerified: false,
      },
      session: {},
    }),
  )

  const user = await resolveAccessUser(resolver, new Headers())

  expect(user?.emailVerified).toBe(false)
})

test('preserves an application role from the authenticated user', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: { id: 'u1', email: 'a@b.c', name: 'Ann', role: 'admin' },
      session: {},
    }),
  )

  const result = await resolver.api.getSession({ headers: new Headers() })

  expect(result?.user?.role).toBe('admin')
})

test('passes an application role into Bunderstack access context', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: { id: 'u1', email: 'a@b.c', name: 'Ann', role: 'admin' },
      session: {},
    }),
  )

  const user = await resolveAccessUser(resolver, new Headers())

  expect(user?.role).toBe('admin')
})

test('maps explicitly selected application user fields into access context', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: {
        id: 'u1',
        email: 'a@b.c',
        name: 'Ann',
        emailVerified: true,
        clinicId: 'clinic-1',
      },
      session: {},
    }),
    {
      mapUser(user) {
        return { clinicId: String(user.clinicId) }
      },
    },
  )

  const user = await resolveAccessUser(resolver, new Headers())

  expect(user?.clinicId).toBe('clinic-1')
})

test('does not let mapped fields override framework-owned identity', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({
      user: {
        id: 'u1',
        email: 'a@b.c',
        name: 'Ann',
        emailVerified: false,
      },
      session: {},
    }),
    {
      mapUser() {
        return {
          id: 'spoofed',
          emailVerified: true,
          clinicId: 'clinic-1',
        } as never
      },
    },
  )

  const user = await resolveAccessUser(resolver, new Headers())

  expect(user).toMatchObject({
    id: 'u1',
    emailVerified: false,
    clinicId: 'clinic-1',
  })
})

test('returns null when there is no session', async () => {
  const resolver = toAuthSessionResolver(fakeAuth(null))
  expect(await resolver.api.getSession({ headers: new Headers() })).toBeNull()
})

test('defaults activeOrganizationId to null when the session lacks one', async () => {
  const resolver = toAuthSessionResolver(
    fakeAuth({ user: { id: 'u1', email: 'a@b.c', name: 'Ann' }, session: {} }),
  )
  const r = await resolver.api.getSession({ headers: new Headers() })
  expect(r?.session).toEqual({ activeOrganizationId: null })
})
