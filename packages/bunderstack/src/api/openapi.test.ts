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
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
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

test('custom api procedure colliding with a framework endpoint prevents application construction', async () => {
  await expect(
    setupApp((o: any) => ({
      shadowOpenAPI: o.public
        .meta(openapi({ method: 'GET', path: '/api/openapi.json' }))
        .input(z.object({}).optional())
        .handler(async () => ({ shadow: true })),
    })),
  ).rejects.toThrow(/reserved|collision|openapi\.json/i)
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

test('mergeOpenAPISpecs rejects path overwrites when operations differ', async () => {
  const { mergeOpenAPISpecs } = await import('./openapi')
  const nativeSpec = {
    paths: {
      '/api/auth/sign-in/email': {
        post: { summary: 'Native sign in' },
      },
    },
  }
  const authSpec = {
    paths: {
      '/api/auth/sign-in/email': {
        post: { summary: 'Auth spec sign in' },
      },
    },
  }
  expect(() => mergeOpenAPISpecs({ nativeSpec, authSpec })).toThrow(
    /path overwrite collision|operation "POST \/api\/auth\/sign-in\/email"/i,
  )
})

test('mergeOpenAPISpecs accepts equal duplicate components and rejects unequal duplicate components', async () => {
  const { mergeOpenAPISpecs } = await import('./openapi')
  const nativeSpec = {
    components: {
      schemas: {
        User: { type: 'object', properties: { id: { type: 'string' } } },
        Session: { type: 'object' },
      },
    },
  }
  const authSpecEqual = {
    components: {
      schemas: {
        User: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  }
  const authSpecUnequal = {
    components: {
      schemas: {
        User: { type: 'object', properties: { id: { type: 'number' } } },
      },
    },
  }

  const merged = mergeOpenAPISpecs({ nativeSpec, authSpec: authSpecEqual })
  expect(merged.components.schemas.User).toBeDefined()
  expect(merged.components.schemas.Session).toBeDefined()

  expect(() =>
    mergeOpenAPISpecs({ nativeSpec, authSpec: authSpecUnequal }),
  ).toThrow(/component collision/i)
})
