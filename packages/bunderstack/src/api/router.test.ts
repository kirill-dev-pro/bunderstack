import { expect, test } from 'bun:test'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { createApiBuilder, defineApi } from './builder'
import { buildApiRouter } from './router'

test('builds health into the same graph and rejects duplicate handles', () => {
  const router = buildApiRouter({ crud: {}, storage: {} })
  expect(router.health).toBeDefined()

  const builder = createApiBuilder()
  const duplicate = builder.public.handler(() => ({ status: 'custom' }))
  expect(() =>
    buildApiRouter({
      crud: {},
      storage: {},
      custom: { health: duplicate },
    }),
  ).toThrow(/health/)
})

test('bunderstack accepts a router object for the api option', async () => {
  const o = defineApi({ schema: {} })
  const api = {
    ping: o.public
      .route({ method: 'GET', path: '/api/ping' })
      .handler(() => ({ pong: true })),
  }

  const app = await bunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    api,
  }).start()

  const response = await app.handler(new Request('http://test/api/ping'))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ pong: true })
  await app.close()
})

test('bunderstack still accepts the api callback', async () => {
  const app = await bunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    api: (o) => ({
      ping: o.public
        .route({ method: 'GET', path: '/api/ping' })
        .handler(() => ({ pong: 'callback' })),
    }),
  }).start()

  const response = await app.handler(new Request('http://test/api/ping'))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ pong: 'callback' })
  await app.close()
})
