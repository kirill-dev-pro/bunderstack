import { describe, it, expect } from 'bun:test'

import pkg from '../../package.json'
import { createStartAuthClient } from './auth-client'
import {
  bunderstackStart,
  createApiHandlers,
  createIsomorphicFetch,
  getSessionUser,
} from './index'

describe('createApiHandlers', () => {
  it('forwards every method to app.handler', async () => {
    const seen: string[] = []
    const app = {
      handler: async (req: Request) => {
        seen.push(req.method)
        return new Response('ok')
      },
    }
    const handlers = createApiHandlers(app)
    const methods = [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ] as const
    for (const method of methods) {
      const res = await handlers[method]({
        request: new Request('http://x/api/posts', { method }),
      })
      expect(await res.text()).toBe('ok')
    }
    expect(seen).toEqual([...methods])
  })

  it('routes PUT to app.handler instead of leaving it to SSR', async () => {
    // A missing PUT key made TanStack Start render the page: the client got
    // 200 with HTML and the write never ran.
    const app = {
      handler: async (req: Request) =>
        Response.json({ method: req.method }, { status: 202 }),
    }
    const res = await createApiHandlers(app).PUT({
      request: new Request('http://x/api/clients/policy', { method: 'PUT' }),
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ method: 'PUT' })
  })
})

describe('createIsomorphicFetch', () => {
  it('resolves relative URLs against APP_URL on the server', async () => {
    const urls: string[] = []
    const inner = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}')
    }) as unknown as typeof fetch
    process.env.APP_URL = 'http://example.test:1234'
    try {
      const iso = createIsomorphicFetch({ fetch: inner })
      await iso('/api/posts')
      expect(urls[0]).toBe('http://example.test:1234/api/posts')
    } finally {
      delete process.env.APP_URL
    }
  })

  it('passes absolute URLs through untouched', async () => {
    const urls: string[] = []
    const inner = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}')
    }) as unknown as typeof fetch
    const iso = createIsomorphicFetch({ fetch: inner })
    await iso('http://other.test/x')
    expect(urls[0]).toBe('http://other.test/x')
  })
})

describe('bunderstackStart', () => {
  it('builds a query client with the default staleTime and a query api', () => {
    const { createQueryClient, createApi } = bunderstackStart()
    const qc = createQueryClient()
    expect(qc.getDefaultOptions().queries?.staleTime).toBe(30_000)
    const api = createApi(qc)
    expect(api).toBeDefined()
    expect(typeof api.files).toBe('object')
  })

  it('honors a custom staleTime', () => {
    const { createQueryClient } = bunderstackStart({ staleTime: 5_000 })
    expect(createQueryClient().getDefaultOptions().queries?.staleTime).toBe(
      5_000,
    )
  })
})

describe('getSessionUser', () => {
  it('returns the session user or null', async () => {
    const app = {
      auth: {
        api: {
          getSession: async () => ({
            user: { id: 'u1', email: 'a@b.c', name: 'A', image: null },
          }),
        },
      },
    }
    const user = await getSessionUser(app, new Request('http://x/'))
    expect(user?.id).toBe('u1')

    const anon = { auth: { api: { getSession: async () => null } } }
    expect(await getSessionUser(anon, new Request('http://x/'))).toBeNull()
  })
})

describe('auth isolation', () => {
  it('exports auth subpath', () => {
    // The auth client lives behind its own entry so importing the root never
    // pulls better-auth into a bundle that does not use it.
    const auth = (pkg.exports as any)['./start-auth'] as {
      types: string
      default: string
    }
    expect(auth.default).toMatch(/\/auth-client\.js$/)
    expect(auth.types).toMatch(/\/auth-client\.d\.ts$/)
  })
  it('exposes createStartAuthClient from the subpath', () => {
    expect(typeof createStartAuthClient).toBe('function')
  })
})
