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
        '/api/other-posts': {
          get: {
            operationId: 'posts.list',
          },
        },
      },
    },
  ]

  expect(buildApiRegistry({ nativeRouter, foreignSpecs })).rejects.toThrow(
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
