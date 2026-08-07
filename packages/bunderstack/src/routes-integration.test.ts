import { test, expect } from 'bun:test'
import { Hono } from 'hono'

import { createBunderstack } from './index'
import { libsql } from './database/libsql'

async function appWith(routes?: unknown) {
  return createBunderstack({
    schema: {},
    database: { adapter: libsql() },
    processEnv: { DATABASE_URL: 'file::memory:', BUNDERSTACK_ROLE: 'web' },
    routes,
  } as never)
}

test('a custom route is served', async () => {
  const app = await appWith((ctx: { env: { BUNDERSTACK_ROLE: string } }) => {
    const r = new Hono()
    r.get('/webhooks/ping', (c) => c.json({ role: ctx.env.BUNDERSTACK_ROLE }))
    return r
  })
  const res = await app.handler(new Request('http://local/webhooks/ping'))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ role: 'web' })
  await app.close()
})

test('a custom route receives the exact raw body', async () => {
  const body = '{"update_id":1,"text":"hé\\u0000llo"}'
  let seen: string | undefined
  const app = await appWith(() => {
    const r = new Hono()
    r.post('/webhooks/raw', async (c) => {
      seen = await c.req.text()
      return c.json({ ok: true })
    })
    return r
  })
  await app.handler(
    new Request('http://local/webhooks/raw', { method: 'POST', body }),
  )
  expect(seen).toBe(body)
  await app.close()
})

test('an app with no routes configured still serves health', async () => {
  const app = await appWith(undefined)
  const res = await app.handler(new Request('http://local/health'))
  expect(res.status).toBe(200)
  await app.close()
})

test('a colliding custom route fails at construction', async () => {
  await expect(
    appWith(() => {
      const r = new Hono()
      r.get('/api/auth/steal', (c) => c.text('nope'))
      return r
    }),
  ).rejects.toThrow(/auth/)
})
