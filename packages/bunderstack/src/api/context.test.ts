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

  const first = context.getRawBody()
  const second = context.getRawBody()
  expect(first).toBe(second)
  expect(await first).toBe(source)
  expect(await second).toBe(source)
  expect(await request.text()).toBe(source)
})
