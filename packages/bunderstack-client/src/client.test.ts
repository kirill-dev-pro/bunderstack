import { expect, test } from 'bun:test'

import { createRestClient, type RouteOperation } from './client'

type Routes = {
  todosList: RouteOperation<
    'GET',
    '/api/todos',
    { limit?: number; filters?: { done?: boolean } },
    undefined,
    { items: { id: string }[] }
  >
  todosCreate: RouteOperation<
    'POST',
    '/api/todos',
    undefined,
    { title: string },
    { id: string; title: string }
  >
  todosLive: RouteOperation<
    'GET',
    '/api/todos/live',
    undefined,
    undefined,
    { type: 'snapshot'; items: { id: string }[] },
    true
  >
  fileDownload: RouteOperation<
    'GET',
    '/api/files/{bucket}/{+path}',
    undefined,
    undefined,
    { ok: true }
  >
  health: RouteOperation<
    'GET',
    '/api/health',
    undefined,
    undefined,
    { ok: true }
  >
}

const routes = {
  todosList: { method: 'GET', path: '/api/todos' },
  todosCreate: { method: 'POST', path: '/api/todos' },
  todosLive: { method: 'GET', path: '/api/todos/live', stream: true },
  fileDownload: {
    method: 'GET',
    path: '/api/files/{bucket}/{+path}',
  },
  health: { method: 'GET', path: '/api/health' },
} as const

test('route calls apply base URL, JSON query encoding, and operation metadata', async () => {
  let received: Request | undefined
  const client = createRestClient<Routes>(routes, {
    baseUrl: 'https://api.example.test/',
    fetch: async (input, init) => {
      received = new Request(input, init)
      return Response.json({ id: 'server-id', title: 'Write tests' })
    },
  })

  const result = await client.todosCreate(
    { body: { title: 'Write tests' } },
    { operationId: 'op-123' },
  )

  expect(result).toEqual({ id: 'server-id', title: 'Write tests' })
  expect(received?.url).toBe('https://api.example.test/api/todos')
  expect(received?.method).toBe('POST')
  expect(received?.headers.get('content-type')).toBe('application/json')
  expect(received?.headers.get('x-bunderstack-operation-id')).toBe('op-123')
  expect(await received?.json()).toEqual({ title: 'Write tests' })
})

test('stream route returns an AsyncIterable synchronously', () => {
  const client = createRestClient<Routes>(routes, {
    fetch: async () => new Response(''),
  })
  const result = client.todosLive()
  expect(result[Symbol.asyncIterator]).toBeFunction()
  expect(result).not.toBeInstanceOf(Promise)
})

test('route calls encode arbitrary and catch-all path parameters', async () => {
  let receivedUrl = ''
  const client = createRestClient<Routes>(routes, {
    fetch: async (input) => {
      receivedUrl = String(input)
      return Response.json({ ok: true })
    },
  })

  await client.fileDownload({
    params: { bucket: 'user files', path: 'avatars/a b.png' },
  })

  expect(receivedUrl).toBe('/api/files/user%20files/avatars/a%20b.png')
})

test('inputless route calls need no placeholder argument', async () => {
  const client = createRestClient<Routes>(routes, {
    fetch: async () => Response.json({ ok: true }),
  })

  expect(await client.health()).toEqual({ ok: true })
})
