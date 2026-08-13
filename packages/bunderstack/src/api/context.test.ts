import { expect, mock, test } from 'bun:test'

import type { AuthSessionResolver } from '../access'

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

test('memoizes lazy session resolution', async () => {
  const getSession = mock(async () => ({
    user: { id: 'usr_1', email: 'user@example.com' },
    session: { activeOrganizationId: 'org_1' },
  }))
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  expect(getSession).toHaveBeenCalledTimes(0)
  const first = context.getSession()
  const second = context.getSession()
  expect(first).toBe(second)
  expect(await first).toEqual(await second)
  expect(getSession).toHaveBeenCalledTimes(1)
})

test('memoizes exact raw body without consuming the original request', async () => {
  const source = '{  "message": "привет",\n "count": 1 }'
  const request = new Request('http://localhost/webhooks/example', {
    method: 'POST',
    body: source,
  })
  const context = createApiContext(createTestDeps(), request)

  expect(await request.text()).toBe(source)
  const first = context.getRawBody()
  const second = context.getRawBody()
  expect(first).toBe(second)
  expect(await first).toBe(source)
  expect(await second).toBe(source)
})

test('peekSession returns undefined and starts no resolution before getSession runs', () => {
  const getSession = mock(async () => ({
    user: { id: 'usr_1', email: 'user@example.com' },
    session: { activeOrganizationId: 'org_1' },
  }))
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  expect(context.peekSession()).toBeUndefined()
  expect(getSession).toHaveBeenCalledTimes(0)
})

test('peekSession returns the resolved session after getSession settles', async () => {
  const getSession = mock(async () => ({
    user: { id: 'usr_1', email: 'user@example.com' },
    session: { activeOrganizationId: 'org_1' },
  }))
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  await context.getSession()

  expect(context.peekSession()?.user?.id).toBe('usr_1')
  expect(context.peekSession()?.activeOrganizationId).toBe('org_1')
  expect(getSession).toHaveBeenCalledTimes(1)
})

test('peekSession returns undefined while getSession is still pending', async () => {
  let release: (value: unknown) => void = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const getSession = mock(async () => {
    await gate
    return {
      user: { id: 'usr_1', email: 'user@example.com' },
      session: { activeOrganizationId: null },
    }
  })
  const authResolver: AuthSessionResolver = { api: { getSession } }
  const context = createApiContext(
    createTestDeps(authResolver),
    new Request('http://localhost/api/test'),
  )

  const pending = context.getSession()
  expect(context.peekSession()).toBeUndefined()

  release(undefined)
  await pending
  expect(context.peekSession()?.user?.id).toBe('usr_1')
})

test('peekSession reports an anonymous caller once the session resolves', async () => {
  const context = createApiContext(
    createTestDeps(),
    new Request('http://localhost/api/test'),
  )

  expect(context.peekSession()).toBeUndefined()
  await context.getSession()
  expect(context.peekSession()).toEqual({
    user: null,
    activeOrganizationId: null,
  })
})
