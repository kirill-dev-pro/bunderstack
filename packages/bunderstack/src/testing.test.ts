import { test, expect } from 'bun:test'

import { mockAuthSession } from './testing'

test('mockAuthSession mocks session resolver on app instance without typecasting', async () => {
  const fakeApp = {
    auth: {
      api: {
        getSession: async () => null,
      },
    },
  }

  mockAuthSession(fakeApp, async () => ({
    user: { id: 'user_123', email: 'test@example.com', role: 'admin' },
  }))

  const session = await (fakeApp.auth.api.getSession as any)({
    headers: new Headers(),
  })

  expect(session?.user?.id).toBe('user_123')
  expect(session?.user?.role).toBe('admin')
})
