import { createProcedureClient, ORPCError } from '@orpc/server'
import { test, expect, mock } from 'bun:test'

import type { AuthSessionResolver } from '../access'

import { createApiBuilder } from './builder'
import { createApiContext } from './context'

function createTestDeps(authResolver?: AuthSessionResolver) {
  return {
    db: { fakeDb: true } as any,
    env: { PORT: 3000 } as any,
    storage: { fakeStorage: true } as any,
    email: { fakeEmail: true } as any,
    jobs: { fakeJobs: true } as any,
    realtime: { fakeRealtime: true } as any,
    auth: { fakeAuth: true } as any,
    authResolver,
  }
}

test('createApiContext memoizes getSession and performs only one auth lookup per request', async () => {
  const getSessionMock = mock(async () => ({
    user: { id: 'usr_1', email: 'user@example.com', name: 'Test User' },
    session: { activeOrganizationId: 'org_123' },
  }))

  const fakeAuthResolver: AuthSessionResolver = {
    api: {
      getSession: getSessionMock,
    },
  }

  const req = new Request('http://localhost/api/test')
  const ctx = createApiContext(createTestDeps(fakeAuthResolver), req)

  expect(getSessionMock).toHaveBeenCalledTimes(0)

  const session1 = await ctx.getSession()
  const session2 = await ctx.getSession()

  expect(getSessionMock).toHaveBeenCalledTimes(1)
  expect(session1).toEqual(session2)
  expect(session1.user?.id).toBe('usr_1')
  expect(session1.activeOrganizationId).toBe('org_123')
})

test('public procedure allows unauthenticated access and provides context', async () => {
  const builder = createApiBuilder()
  const publicProc = builder.public.handler(async ({ context }) => {
    const session = await context.getSession()
    return {
      hasDb: !!context.db,
      userId: session.user?.id ?? null,
    }
  })

  const req = new Request('http://localhost/api/public')
  const ctx = createApiContext(createTestDeps(), req)

  const client = createProcedureClient(publicProc, { context: ctx })
  const res = await client()
  expect(res.hasDb).toBe(true)
  expect(res.userId).toBeNull()
})

test('protected procedure rejects unauthenticated requests with UNAUTHORIZED', async () => {
  const getSessionMock = mock(async () => null)
  const fakeAuthResolver: AuthSessionResolver = {
    api: { getSession: getSessionMock },
  }

  const builder = createApiBuilder()
  const protectedProc = builder.protected.handler(async ({ context }) => {
    return { userId: context.user.id }
  })

  const req = new Request('http://localhost/api/protected')
  const ctx = createApiContext(createTestDeps(fakeAuthResolver), req)

  const client = createProcedureClient(protectedProc, { context: ctx })
  expect(client()).rejects.toThrow(ORPCError)
  try {
    await client()
  } catch (err: any) {
    expect(err.code).toBe('UNAUTHORIZED')
  }
})

test('protected procedure passes non-null user and session context when authenticated', async () => {
  const getSessionMock = mock(async () => ({
    user: { id: 'usr_99', email: 'owner@example.com' },
    session: { activeOrganizationId: 'org_99' },
  }))

  const fakeAuthResolver: AuthSessionResolver = {
    api: { getSession: getSessionMock },
  }

  const builder = createApiBuilder()
  const protectedProc = builder.protected.handler(async ({ context }) => {
    return {
      userId: context.user.id,
      email: context.user.email,
      orgId: context.session?.activeOrganizationId ?? null,
    }
  })

  const req = new Request('http://localhost/api/protected')
  const ctx = createApiContext(createTestDeps(fakeAuthResolver), req)

  const client = createProcedureClient(protectedProc, { context: ctx })
  const res = await client()
  expect(res.userId).toBe('usr_99')
  expect(res.email).toBe('owner@example.com')
  expect(res.orgId).toBe('org_99')
  expect(getSessionMock).toHaveBeenCalledTimes(1)
})

test('public and webhook bases do not resolve auth implicitly', async () => {
  const getSessionMock = mock(async () => null)
  const fakeAuthResolver: AuthSessionResolver = {
    api: { getSession: getSessionMock },
  }
  const context = createApiContext(
    createTestDeps(fakeAuthResolver),
    new Request('http://localhost/webhooks/example'),
  )
  const builder = createApiBuilder()
  const publicClient = createProcedureClient(
    builder.public.handler(() => 'public'),
    { context },
  )
  const webhookClient = createProcedureClient(
    builder.webhook.handler(() => 'webhook'),
    { context },
  )

  expect(await publicClient()).toBe('public')
  expect(await webhookClient()).toBe('webhook')
  expect(getSessionMock).toHaveBeenCalledTimes(0)
})
