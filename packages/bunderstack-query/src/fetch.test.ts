import { expect, test } from 'bun:test'

import { createFetch } from './fetch'

test('custom fetch receives a relative RPC URL unchanged', async () => {
  let received = ''
  const customFetch = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    received = input instanceof Request ? input.url : input.toString()
    return new Response('{}')
  }

  await createFetch(customFetch)('/api/rpc/realtime/changes', {
    method: 'POST',
  })

  expect(received).toBe('/api/rpc/realtime/changes')
})
