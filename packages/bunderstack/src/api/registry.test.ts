import { test, expect } from 'bun:test'
import { os } from '@orpc/server'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'
import { buildApiRegistry } from './registry'

test('buildApiRegistry collects and normalizes native and foreign routes', async () => {
  const nativeRouter = {
    posts: {
      list: os
        .meta(openapi({ method: 'GET', path: '/api/posts' }))
        .input(z.object({ limit: z.number().optional() }))
        .handler(async () => []),
      get: os
        .meta(openapi({ method: 'GET', path: '/api/posts/{id}' }))
        .input(z.object({ id: z.string() }))
        .handler(async () => null),
    },
  }

  const foreignSpecs = [
    {
      paths: {
        '/api/auth/sign-in': {
          post: {
            operationId: 'auth.signIn',
            summary: 'Sign in with email',
          },
        },
      },
    },
  ]

  const registry = await buildApiRegistry({ nativeRouter, foreignSpecs })
  expect(registry.entries).toHaveLength(3)

  const postList = registry.entries.find((e) => e.handle === 'posts.list')
  expect(postList).toBeDefined()
  expect(postList?.method).toBe('GET')
  expect(postList?.path).toBe('/api/posts')
  expect(postList?.source).toBe('native')

  const authSignIn = registry.entries.find((e) => e.operationId === 'auth.signIn')
  expect(authSignIn).toBeDefined()
  expect(authSignIn?.method).toBe('POST')
  expect(authSignIn?.path).toBe('/api/auth/sign-in')
  expect(authSignIn?.source).toBe('foreign')
})

test('buildApiRegistry allows static and parameter routes at the same path level', async () => {
  const nativeRouter = {
    users: {
      me: os
        .meta(openapi({ method: 'GET', path: '/api/users/me' }))
        .input(z.object({}))
        .handler(async () => null),
      get: os
        .meta(openapi({ method: 'GET', path: '/api/users/{id}' }))
        .input(z.object({ id: z.string() }))
        .handler(async () => null),
    },
  }

  const registry = await buildApiRegistry({ nativeRouter })
  expect(registry.entries).toHaveLength(2)
})

test('buildApiRegistry fails on duplicate handles', async () => {
  const foreignSpecs = [
    {
      spec: {
        paths: {
          '/api/auth/me': {
            get: { summary: 'Get current user' },
          },
        },
      },
      prefix: '/api/auth',
      source: 'auth',
    },
    {
      spec: {
        paths: {
          '/api/auth/me': {
            get: { summary: 'Get current user duplicate' },
          },
        },
      },
      prefix: '/api/auth',
      source: 'auth',
    },
  ]

  expect(buildApiRegistry({ foreignSpecs })).rejects.toThrow(
    /duplicate handle/i,
  )
})

test('buildApiRegistry fails on duplicate operation IDs', async () => {
  const nativeRouter = {
    posts: {
      list: os
        .meta(openapi({ method: 'GET', path: '/api/posts' }))
        .input(z.object({}))
        .handler(async () => []),
    },
  }

  const foreignSpecs = [
    {
      paths: {
        '/api/items': {
          get: {
            operationId: 'posts.list',
          },
        },
      },
    },
  ]

  expect(buildApiRegistry({ nativeRouter, foreignSpecs })).rejects.toThrow(
    /operation id/i,
  )
})

test('buildApiRegistry fails on exact method and path collision across native and foreign', async () => {
  const nativeRouter = {
    posts: {
      get: os
        .meta(openapi({ method: 'GET', path: '/api/posts/{id}' }))
        .input(z.object({ id: z.string() }))
        .handler(async () => null),
    },
  }

  const foreignSpecs = [
    {
      paths: {
        '/api/posts/:id': {
          get: {
            operationId: 'foreign.getPost',
          },
        },
      },
    },
  ]

  expect(buildApiRegistry({ nativeRouter, foreignSpecs })).rejects.toThrow(
    /exact method\/path collision|collision/i,
  )
})

test('buildApiRegistry fails on ambiguous parameter paths', async () => {
  const nativeRouter = {
    users: {
      getById: os
        .meta(openapi({ method: 'GET', path: '/api/users/{id}' }))
        .input(z.object({ id: z.string() }))
        .handler(async () => null),
      getBySlug: os
        .meta(openapi({ method: 'GET', path: '/api/users/{slug}' }))
        .input(z.object({ slug: z.string() }))
        .handler(async () => null),
    },
  }

  expect(buildApiRegistry({ nativeRouter })).rejects.toThrow(
    /ambiguous parameter path|collision/i,
  )
})

test('mergeApiRoutersStrict fails on duplicate handle even with different path', async () => {
  const { mergeApiRoutersStrict } = await import('./registry')
  const crud = {
    posts: {
      list: os
        .meta(openapi({ method: 'GET', path: '/api/posts' }))
        .handler(async () => []),
    },
  }
  const custom = {
    posts: {
      list: os
        .meta(openapi({ method: 'GET', path: '/api/archive-posts' }))
        .handler(async () => []),
    },
  }

  expect(() => mergeApiRoutersStrict(crud, custom)).toThrow(/posts\.list/)
})

test('buildApiRegistry fails on post-prefix auth collision', async () => {
  const nativeRouter = {
    auth: {
      signIn: {
        email: os
          .meta(openapi({ method: 'POST', path: '/api/auth/sign-in/email' }))
          .handler(async () => null),
      },
    },
  }
  const foreignSpecs = [
    {
      spec: {
        paths: {
          '/sign-in/email': {
            post: {
              operationId: 'auth.signInEmail',
            },
          },
        },
      },
      prefix: '/api/auth',
      source: 'auth',
    },
  ]

  await expect(
    buildApiRegistry({ nativeRouter, foreignSpecs }),
  ).rejects.toThrow(/POST \/api\/auth\/sign-in\/email/)
})

test('buildApiRegistry fails when distinct handles share the same explicit operationId', async () => {
  const nativeRouter = {
    posts: {
      list: os
        .meta(openapi({ method: 'GET', path: '/api/posts', operationId: 'customOp' }))
        .input(z.object({}))
        .handler(async () => []),
      archive: os
        .meta(openapi({ method: 'GET', path: '/api/archive-posts', operationId: 'customOp' }))
        .input(z.object({}))
        .handler(async () => []),
    },
  }

  await expect(buildApiRegistry({ nativeRouter })).rejects.toThrow(
    /duplicate operation ID "customOp"/i,
  )
})

