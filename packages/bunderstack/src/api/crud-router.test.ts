import { PGlite } from '@electric-sql/pglite'
import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { ValibotToJsonSchemaConverter } from '@orpc/valibot'
import { test, expect } from 'bun:test'
import { pgTable, text, integer } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'

import { validateAndResolveAccess } from '../access'
import { createApiContext } from './context'
import { buildCrudApiRouter } from './crud-router'

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
  expect(Object.keys(crudRouter.posts).sort()).toEqual([
    'create',
    'delete',
    'get',
    'list',
    'update',
  ])
  const openapiHandler = new OpenAPIHandler({ router: crudRouter })

  const mockDeps = createMockDeps(db)

  // 1. Create a post (POST /api/posts)
  const createReq = new Request('http://localhost/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'p1',
      title: 'First Post',
      content: 'Hello World',
    }),
  })
  const createCtx = createApiContext(mockDeps, createReq)
  const createRes = await openapiHandler.handle(createReq, {
    context: createCtx,
  })

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
  expect(listData.items).toHaveLength(1)
  expect(listData.items[0].id).toBe('p1')
  expect(listData.data).toBeUndefined()

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
  const updateRes = await openapiHandler.handle(updateReq, {
    context: updateCtx,
  })

  expect(updateRes.matched).toBe(true)
  expect(updateRes.response!.status).toBe(200)
  const updated = (await updateRes.response!.json()) as any
  expect(updated.title).toBe('Updated Post')

  // 5. Delete post (DELETE /api/posts/p1)
  const deleteReq = new Request('http://localhost/api/posts/p1', {
    method: 'DELETE',
  })
  const deleteCtx = createApiContext(mockDeps, deleteReq)
  const deleteRes = await openapiHandler.handle(deleteReq, {
    context: deleteCtx,
  })

  expect(deleteRes.matched).toBe(true)
  expect(deleteRes.response!.status).toBe(204)
})

test('buildCrudApiRouter validates input shapes on update and produces concrete OpenAPI schema', async () => {
  const db = await setupTestDb()
  const access = validateAndResolveAccess(schema, {
    posts: {
      crud: true,
      create: 'public',
      update: 'public',
    },
  })

  const crudRouter = buildCrudApiRouter(schema, db, { access })
  const openapiHandler = new OpenAPIHandler({ router: crudRouter })
  const mockDeps = createMockDeps(db)

  // Seed p1
  const createReq = new Request('http://localhost/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'p1', title: 'Post' }),
  })
  await openapiHandler.handle(createReq, {
    context: createApiContext(mockDeps, createReq),
  })

  // Invalid column type (likes must be integer, passed invalid string)
  const invalidUpdateReq = new Request('http://localhost/api/posts/p1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ likes: 'not-an-integer' }),
  })
  const invalidUpdateCtx = createApiContext(mockDeps, invalidUpdateReq)
  const invalidRes = await openapiHandler.handle(invalidUpdateReq, {
    context: invalidUpdateCtx,
  })
  expect(invalidRes.matched).toBe(true)
  expect(invalidRes.response!.status).toBe(400)

  // Verify OpenAPI generator schema describes concrete column types
  const generator = new OpenAPIGenerator({
    converters: [new ValibotToJsonSchemaConverter()],
  })
  const spec = await generator.generate(crudRouter)
  const patchOperation = spec.paths?.['/api/posts/{id}']?.patch
  expect(patchOperation).toBeDefined()
  const requestBody = patchOperation?.requestBody
  expect(requestBody).toBeDefined()
  if (requestBody && 'content' in requestBody) {
    const requestBodySchema = requestBody.content?.['application/json']?.schema
    expect(requestBodySchema).toBeDefined()
  }
})

test('generated write contracts reject unknown and immutable fields', async () => {
  const db = await setupTestDb()
  const access = validateAndResolveAccess(schema, {
    posts: { crud: true, create: 'public', update: 'public' },
  })
  const crudRouter = buildCrudApiRouter(schema, db, { access })
  const handler = new OpenAPIHandler({ router: crudRouter })
  const deps = createMockDeps(db)

  const unknownFieldRequest = new Request('http://localhost/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'p1', title: 'Post', unexpected: true }),
  })
  const unknownFieldResult = await handler.handle(unknownFieldRequest, {
    context: createApiContext(deps, unknownFieldRequest),
  })
  expect(unknownFieldResult.response?.status).toBe(400)

  const createRequest = new Request('http://localhost/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'p1', title: 'Post' }),
  })
  await handler.handle(createRequest, {
    context: createApiContext(deps, createRequest),
  })

  const immutableIdRequest = new Request('http://localhost/api/posts/p1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'p2', title: 'Changed' }),
  })
  const immutableIdResult = await handler.handle(immutableIdRequest, {
    context: createApiContext(deps, immutableIdRequest),
  })
  expect(immutableIdResult.response?.status).toBe(400)
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
