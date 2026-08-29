import { expect, test } from 'bun:test'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'

import { generateRouteMap, operationName, schemaToType } from './codegen'
import { pglite } from './database/pglite'
import { bunderstack } from './index'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('user_id'),
  likes: integer('likes').default(0),
})

test('operation names follow the path shape deterministically', () => {
  expect(operationName('/api/posts', 'get')).toBe('postsList')
  expect(operationName('/api/posts', 'post')).toBe('postsCreate')
  expect(operationName('/api/posts/{id}', 'get')).toBe('postsGet')
  expect(operationName('/api/posts/{id}', 'patch')).toBe('postsUpdate')
  expect(operationName('/api/posts/{id}', 'delete')).toBe('postsDelete')
  expect(operationName('/api/posts/live', 'get')).toBe('postsLive')
  expect(operationName('/api/enrich', 'post')).toBe('enrichCreate')
})

test('schema mapper covers the shapes bunderstack emits', () => {
  expect(schemaToType({ type: 'string' })).toBe('string')
  expect(schemaToType({ type: 'integer' })).toBe('number')
  expect(schemaToType({ enum: ['asc', 'desc'] })).toBe('"asc" | "desc"')
  expect(schemaToType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(
    'string | null',
  )
  expect(
    schemaToType({
      type: 'object',
      properties: { id: { type: 'string' }, likes: { type: 'integer' } },
      required: ['id'],
    }),
  ).toBe('{ "id": string; "likes"?: number }')
  expect(
    schemaToType(
      { $ref: '#/components/schemas/Post' },
      {
        Post: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    ),
  ).toBe('{ "id": string }')
})

test('generated route map carries literals plus typed phantoms', async () => {
  const app = await bunderstack({
    schema: { posts },
    database: { adapter: pglite() },

    access: {
      posts: {
        crud: true,
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
        filterableColumns: ['userId'],
        sortableColumns: ['id', 'likes'],
      },
    },
    realtime: true,
    openapi: true,
  }).start({ env: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' } })
  const response = await app.handler(
    new Request('http://test/api/openapi.json'),
  )
  const spec = await response.json()
  await app.close()

  const code = generateRouteMap(spec)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  // Throws if the emitted code does not parse.
  transpiler.transformSync(code)

  for (const expected of [
    `postsList: Op<'GET', '/api/posts',`,
    `postsCreate: Op<'POST', '/api/posts', undefined,`,
    `livePosts: Op<'GET', '/api/live/posts',`,
    `"id" | "likes"`, // sort picklist reaches the query type
    'export const routes = {',
    `"filters"?:`,
  ]) {
    if (!code.includes(expected)) {
      console.error(`missing ${expected} in:\n${code}`)
    }
    expect(code).toContain(expected)
  }
})

test('generated route maps leave Better Auth routes to its official client', () => {
  const operation = {
    responses: {
      200: {
        content: {
          'application/json': { schema: { type: 'object' } },
        },
      },
    },
  }
  const code = generateRouteMap({
    paths: {
      '/api/posts': { get: operation },
      '/api/auth/get-session': { get: operation },
    },
  })

  expect(code).toContain("postsList: Op<'GET', '/api/posts'")
  expect(code).not.toContain('/api/auth/get-session')
})
