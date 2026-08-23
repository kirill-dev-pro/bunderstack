import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'bun:test'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'

import { pglite } from './database/pglite'
import { generateClientCode, operationName, schemaToType } from './codegen'
import { createBunderstack } from './index'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('user_id'),
  likes: integer('likes').default(0),
})

async function buildSpecApp() {
  return createBunderstack({
    schema: { posts },
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
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
  })
}

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
  expect(
    schemaToType({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
  ).toBe('string | null')
  expect(
    schemaToType({
      type: 'object',
      properties: { id: { type: 'string' }, likes: { type: 'integer' } },
      required: ['id'],
    }),
  ).toBe('{ "id": string; "likes"?: number }')
  expect(schemaToType({ $ref: '#/components/schemas/PostsListOutput' })).toBe(
    'PostsListOutput',
  )
})

test('generated client is standalone TypeScript with live streaming', async () => {
  const app = await buildSpecApp()
  const response = await app.handler(
    new Request('http://test/api/openapi.json'),
  )
  const spec = await response.json()
  await app.close()

  const code = generateClientCode(spec)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  // Throws if the emitted code does not parse.
  transpiler.transformSync(code)

  for (const expected of [
    'export async function postsList(',
    'export async function postsCreate(',
    'export async function postsUpdate(',
    'export async function* postsLive(',
    'AsyncIterable<',
    'sseFrames',
  ]) {
    expect(code).toContain(expected)
  }
  // The live input carries filters and the snapshot frames are typed.
  expect(code).toMatch(/postsLive\([\s\S]*?"filters"\??:/)
})
