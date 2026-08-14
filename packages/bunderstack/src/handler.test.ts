import { expect, test } from 'bun:test'
import * as v from 'valibot'

import { libsql } from './database/libsql'
import { buildHandler } from './handler'
import { createBunderstack } from './index'

test('dispatches rate limit, auth, API, then 404', async () => {
  const calls: string[] = []
  const handler = buildHandler({
    rateLimit: { max: 0 },
    authHandler: async () => {
      calls.push('auth')
      return new Response('auth')
    },
    apiHandler: async () => {
      calls.push('api')
      return new Response('api')
    },
  })
  expect(
    (await handler(new Request('http://test/api/auth/session'))).status,
  ).toBe(429)
  expect(calls).toEqual([])

  const normal = buildHandler({
    authHandler: async () => new Response('auth'),
    apiHandler: async (request) =>
      new URL(request.url).pathname === '/api/value'
        ? new Response('api')
        : null,
  })
  expect(
    await (await normal(new Request('http://test/api/auth/x'))).text(),
  ).toBe('auth')
  expect(
    await (await normal(new Request('http://test/api/value'))).text(),
  ).toBe('api')
  expect((await normal(new Request('http://test/missing'))).status).toBe(404)
})

test('webhook receives exact raw bytes and does not resolve auth', async () => {
  let authCalls = 0
  const raw = '{ "event" : "created", "escaped": "h\\u00e9" }'
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    authResolver: {
      api: {
        getSession: async () => {
          authCalls++
          return null
        },
      },
    },
    api: (o) => ({
      webhook: o.webhook
        .route({
          method: 'POST',
          path: '/webhooks/example',
          inputStructure: 'detailed',
        })
        .input(
          v.strictObject({
            params: v.optional(v.strictObject({}), {}),
            query: v.optional(v.record(v.string(), v.unknown()), {}),
            headers: v.record(v.string(), v.unknown()),
            body: v.record(v.string(), v.unknown()),
          }),
        )
        .handler(async ({ input, context }) => ({
          valid: input.headers['x-signature'] === (await context.getRawBody()),
        })),
    }),
  })

  const response = await app.handler(
    new Request('http://test/webhooks/example', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': raw,
      },
      body: raw,
    }),
  )
  expect(await response.json()).toEqual({ valid: true })
  expect(authCalls).toBe(0)
  await app.close()
})
