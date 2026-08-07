import { test, expect } from 'bun:test'

import { validateCustomRoutes, createRouteContext } from './routes'

const ok = (path: string, tables: string[] = ['posts']) =>
  validateCustomRoutes([{ method: 'POST', path }], tables)

test('a non-colliding path is accepted', () => {
  expect(() => ok('/webhooks/telegram')).not.toThrow()
  expect(() => ok('/api/webhooks/stripe')).not.toThrow()
})

test('exact reserved paths are rejected', () => {
  expect(() => ok('/health')).toThrow(/health/)
  expect(() => ok('/api/health')).toThrow(/health/)
  expect(() => ok('/api/realtime')).toThrow(/realtime/)
})

test('reserved prefixes are rejected', () => {
  expect(() => ok('/api/auth/callback')).toThrow(/auth/)
  expect(() => ok('/api/trpc/anything')).toThrow(/trpc/)
  expect(() => ok('/api/files/x')).toThrow(/files/)
  expect(() => ok('/files/x')).toThrow(/files/)
})

test('an enabled table name is rejected', () => {
  expect(() => ok('/api/posts')).toThrow(/posts/)
  expect(() => ok('/api/posts/42')).toThrow(/posts/)
})

test('a table that is not enabled does not collide', () => {
  expect(() => ok('/api/drafts', ['posts'])).not.toThrow()
})

test('a param or wildcard first segment under /api is rejected', () => {
  expect(() => ok('/api/:anything')).toThrow(/shadow/)
  expect(() => ok('/api/:anything/x')).toThrow(/shadow/)
  expect(() => ok('/api/*')).toThrow(/shadow/)
})

test('params outside the first /api segment are fine', () => {
  expect(() => ok('/api/webhooks/:provider')).not.toThrow()
  expect(() => ok('/:anything')).not.toThrow()
})

test('the error names the offending path', () => {
  expect(() => ok('/api/posts')).toThrow(/POST \/api\/posts/)
})

test('every colliding route is reported, not just the first', () => {
  expect(() =>
    validateCustomRoutes(
      [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/api/posts' },
      ],
      ['posts'],
    ),
  ).toThrow(/health[\s\S]*posts/)
})

test('createRouteContext exposes the framework facades', () => {
  const ctx = createRouteContext({
    db: 'DB' as never,
    env: { NODE_ENV: 'test' } as never,
    storage: 'STORAGE' as never,
    email: 'EMAIL' as never,
    jobs: 'JOBS' as never,
    realtime: 'REALTIME' as never,
    auth: 'AUTH' as never,
    authResolver: undefined,
  })
  expect(ctx.db).toBe('DB' as never)
  expect(ctx.storage).toBe('STORAGE' as never)
  expect(ctx.jobs).toBe('JOBS' as never)
  expect(typeof ctx.getSession).toBe('function')
  expect(typeof ctx.getUser).toBe('function')
})

test('getSession returns nulls when no auth resolver is configured', async () => {
  const ctx = createRouteContext({
    db: 'DB' as never,
    env: {} as never,
    storage: 'S' as never,
    email: 'E' as never,
    jobs: 'J' as never,
    realtime: 'R' as never,
    auth: 'A' as never,
    authResolver: undefined,
  })
  const session = await ctx.getSession(new Request('http://local/x'))
  expect(session).toEqual({ user: null, activeOrganizationId: null })
  expect(await ctx.getUser(new Request('http://local/x'))).toBeNull()
})

test('getSession is lazy — building the context resolves nothing', () => {
  let calls = 0
  const authResolver = {
    api: {
      getSession: async () => {
        calls++
        return null
      },
    },
  }
  createRouteContext({
    db: 'DB' as never,
    env: {} as never,
    storage: 'S' as never,
    email: 'E' as never,
    jobs: 'J' as never,
    realtime: 'R' as never,
    auth: 'A' as never,
    authResolver: authResolver as never,
  })
  expect(calls).toBe(0)
})

