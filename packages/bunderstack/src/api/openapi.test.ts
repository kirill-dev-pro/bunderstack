import { test, expect } from 'bun:test'
import { os } from '@orpc/server'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'

import { createBunderstack } from '../index'
import { pglite } from '../database/pglite'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const schema = { posts }

async function setupApp(api?: any, accessOverrides?: any, auth?: any) {
  return await createBunderstack({
    schema,
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'file:./test-openapi.pglite', BUNDERSTACK_ROLE: 'web' },
    access: {
      posts: { crud: true, list: 'public', get: 'public', ...accessOverrides },
    },
    api,
    auth,
  } as any)
}

test('mounts custom api endpoint, RPC transport, and OpenAPI JSON', async () => {
  const app = await setupApp((o: any) => ({
    stats: {
      get: o.public
        .meta(openapi({ method: 'GET', path: '/api/stats' }))
        .input(z.object({}).optional())
        .handler(async () => ({ totalPosts: 42 })),
    },
  }))

  // 1. Custom API HTTP route (GET /api/stats)
  const statsRes = await app.handler(new Request('http://localhost/api/stats'))
  expect(statsRes.status).toBe(200)
  expect(await statsRes.json()).toEqual({ totalPosts: 42 })

  // 2. RPC transport (POST /api/rpc/stats/get)
  const rpcRes = await app.handler(
    new Request('http://localhost/api/rpc/stats/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: {} }),
    }),
  )
  expect(rpcRes.status).toBe(200)
  expect(await rpcRes.json()).toEqual({ json: { totalPosts: 42 } })

  // 3. Merged OpenAPI document (GET /api/openapi.json)
  const openapiRes = await app.handler(new Request('http://localhost/api/openapi.json'))
  expect(openapiRes.status).toBe(200)
  const doc = (await openapiRes.json()) as any
  expect(doc.openapi).toBeDefined()
  expect(doc.paths['/api/posts']).toBeDefined()
  expect(doc.paths['/api/stats']).toBeDefined()

  await app.close()
})

test('custom route colliding with CRUD prevents application construction', async () => {
  await expect(
    setupApp((o: any) => ({
      posts: {
        list: o.public
          .meta(openapi({ method: 'GET', path: '/api/posts' }))
          .input(z.object({}))
          .handler(async () => []),
      },
    })),
  ).rejects.toThrow(/collision|registry/i)
})

test('auth OpenAPI paths and security metadata are included in combined OpenAPI document', async () => {
  const app = await setupApp(undefined, undefined, {
    secret: 'test-secret-12345678901234567890',
    baseURL: 'http://localhost:3000',
  })

  const openapiRes = await app.handler(new Request('http://localhost/api/openapi.json'))
  expect(openapiRes.status).toBe(200)
  const doc = (await openapiRes.json()) as any

  expect(doc.paths['/api/auth/sign-in/email']).toBeDefined()
  expect(doc.components?.schemas?.User).toBeDefined()

  await app.close()
})
