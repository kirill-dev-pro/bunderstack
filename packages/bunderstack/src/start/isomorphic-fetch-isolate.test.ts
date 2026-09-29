import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  registerWorker,
  rememberWorkerEnv,
  resetRegistryForTests,
} from '../workers/registry'
import { createIsomorphicFetch } from './isomorphic-fetch'

beforeEach(() => resetRegistryForTests())
afterEach(() => resetRegistryForTests())

test('on the server a registered Worker is called in the isolate with the cookie', async () => {
  const seen: Request[] = []
  registerWorker({
    async fetch(request) {
      seen.push(request)
      return new Response('in-isolate')
    },
  })
  rememberWorkerEnv({})
  try {
    const iso = createIsomorphicFetch({
      fetch: (async () => new Response('network')) as unknown as typeof fetch,
      isolate: {
        request: async () =>
          new Request('https://app.example/boards', {
            headers: { cookie: 'better-auth.session_token=abc' },
          }),
      },
    })
    const res = await iso('/api/notes?limit=1', { headers: { 'x-a': '1' } })
    expect(await res.text()).toBe('in-isolate')
    expect(seen[0]!.url).toBe('https://app.example/api/notes?limit=1')
    expect(seen[0]!.headers.get('cookie')).toBe('better-auth.session_token=abc')
    expect(seen[0]!.headers.get('x-a')).toBe('1')
  } finally {
    resetRegistryForTests()
  }
})

test('without a registered Worker the server path keeps using the network', async () => {
  const urls: string[] = []
  const iso = createIsomorphicFetch({
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('network')
    }) as typeof fetch,
  })
  const previous = process.env.APP_URL
  process.env.APP_URL = 'https://app.example'
  try {
    expect(await (await iso('/api/x')).text()).toBe('network')
    expect(urls).toEqual(['https://app.example/api/x'])
  } finally {
    if (previous === undefined) delete process.env.APP_URL
    else process.env.APP_URL = previous
  }
})
