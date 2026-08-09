import { test, expect } from 'bun:test'
import { pgTable, text, integer } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { createApiContext } from './context'
import { buildCrudApiRouter } from './crud-router'
import { validateAndResolveAccess } from '../access'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content'),
  userId: text('user_id'),
  likes: integer('likes').default(0),
})

const schema = { posts }

async function setupTestDb() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      user_id TEXT,
      likes INTEGER DEFAULT 0
    );
  `)
  return drizzle(client, { schema })
}

function createMockDeps(db: any, authResolver?: any) {
  return {
    db,
    env: {},
    storage: {} as any,
    email: {} as any,
    jobs: {} as any,
    realtime: {} as any,
    auth: {} as any,
    authResolver,
  }
}

test('buildCrudApiRouter creates endpoints for list, get, create, update, delete at existing URLs', async () => {
  const db = await setupTestDb()
  const access = validateAndResolveAccess(schema, {
    posts: {
      crud: true,
      list: 'public',
      get: 'public',
      create: 'public',
      update: 'public',
      delete: 'public',
    },
  })

  const crudRouter = buildCrudApiRouter(schema, db, { access })
  const openapiHandler = new OpenAPIHandler({ router: crudRouter })

  const mockDeps = createMockDeps(db)

  // 1. Create a post (POST /api/posts)
  const createReq = new Request('http://localhost/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'p1', title: 'First Post', content: 'Hello World' }),
  })
  const createCtx = createApiContext(mockDeps, createReq)
  const createRes = await openapiHandler.handle(createReq, { context: createCtx })

  expect(createRes.matched).toBe(true)
  expect(createRes.response!.status).toBe(201)
  const created = await createRes.response!.json()
  expect(created).toEqual({
    id: 'p1',
    title: 'First Post',
    content: 'Hello World',
    userId: null,
    likes: 0,
  })

  // 2. List posts (GET /api/posts)
  const listReq = new Request('http://localhost/api/posts', { method: 'GET' })
  const listCtx = createApiContext(mockDeps, listReq)
  const listRes = await openapiHandler.handle(listReq, { context: listCtx })

  expect(listRes.matched).toBe(true)
  expect(listRes.response!.status).toBe(200)
  const listData = (await listRes.response!.json()) as any
  expect(listData.data).toHaveLength(1)
  expect(listData.data[0].id).toBe('p1')

  // 3. Get single post (GET /api/posts/p1)
  const getReq = new Request('http://localhost/api/posts/p1', { method: 'GET' })
  const getCtx = createApiContext(mockDeps, getReq)
  const getRes = await openapiHandler.handle(getReq, { context: getCtx })

  expect(getRes.matched).toBe(true)
  expect(getRes.response!.status).toBe(200)
  const fetched = (await getRes.response!.json()) as any
  expect(fetched.title).toBe('First Post')

  // 4. Update post (PATCH /api/posts/p1)
  const updateReq = new Request('http://localhost/api/posts/p1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Updated Post' }),
  })
  const updateCtx = createApiContext(mockDeps, updateReq)
  const updateRes = await openapiHandler.handle(updateReq, { context: updateCtx })

  expect(updateRes.matched).toBe(true)
  expect(updateRes.response!.status).toBe(200)
  const updated = (await updateRes.response!.json()) as any
  expect(updated.title).toBe('Updated Post')

  // 5. Delete post (DELETE /api/posts/p1)
  const deleteReq = new Request('http://localhost/api/posts/p1', { method: 'DELETE' })
  const deleteCtx = createApiContext(mockDeps, deleteReq)
  const deleteRes = await openapiHandler.handle(deleteReq, { context: deleteCtx })

  expect(deleteRes.matched).toBe(true)
  expect(deleteRes.response!.status).toBe(204)
})

test('buildCrudApiRouter respects access control and session', async () => {
  const db = await setupTestDb()
  const access = validateAndResolveAccess(schema, {
    posts: {
      crud: true,
      list: 'deny',
      get: 'public',
      create: 'public',
      update: 'public',
      delete: 'public',
    },
  })

  const crudRouter = buildCrudApiRouter(schema, db, { access })
  const openapiHandler = new OpenAPIHandler({ router: crudRouter })

  const mockDeps = createMockDeps(db)

  const listReq = new Request('http://localhost/api/posts', { method: 'GET' })
  const listCtx = createApiContext(mockDeps, listReq)
  const listRes = await openapiHandler.handle(listReq, { context: listCtx })

  expect(listRes.matched).toBe(true)
  expect(listRes.response!.status).toBe(403)
})
