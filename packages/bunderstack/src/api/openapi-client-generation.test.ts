import { test, expect } from 'bun:test'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as v from 'valibot'

import { pglite } from '../database/pglite'
import { createBunderstack } from '../index'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const privateNotes = pgTable('private_notes', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
})

const schema = { posts, privateNotes }

async function setupApp() {
  return await createBunderstack({
    schema,
    database: { adapter: pglite() },
    processEnv: {
      DATABASE_URL: 'memory://',
      BUNDERSTACK_ROLE: 'web',
    },
    openapi: true,
    storage: {
      local: true,
      buckets: { images: { visibility: 'public' } },
    },
    access: {
      posts: {
        crud: true,
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
      },
      privateNotes: { crud: false },
    },
    api: (o) => ({
      stats: o.public
        .route({ method: 'GET', path: '/api/stats' })
        .input(v.object({ period: v.string() }))
        .output(v.object({ totalPosts: v.number() }))
        .handler(async () => ({ totalPosts: 42 })),
    }),
  })
}

test('reproducible openapi-typescript client generation and type verification', async () => {
  const app = await setupApp()
  const res = await app.handler(
    new Request('http://localhost/api/openapi.json'),
  )
  expect(res.status).toBe(200)

  const spec = (await res.json()) as any

  // 1. Concrete schema assertions
  // Disabled table absent
  expect(spec.paths['/api/private-notes']).toBeUndefined()

  // Custom procedure present
  expect(spec.paths['/api/stats']).toBeDefined()
  expect(spec.paths['/api/stats'].get).toBeDefined()

  // Generated storage procedures are part of the same mobile-facing spec
  expect(spec.paths['/api/files/images/presign'].post).toBeDefined()
  expect(spec.paths['/api/files/images'].post).toBeDefined()

  // Auth paths under /api/auth/* exactly once
  const authPaths = Object.keys(spec.paths).filter((p) =>
    p.startsWith('/api/auth/'),
  )
  expect(authPaths.length).toBeGreaterThan(0)
  expect(
    Object.keys(spec.paths).filter((p) => p === '/sign-in/email'),
  ).toHaveLength(0)

  // CRUD create requires title
  const createReqBody =
    spec.paths['/api/posts'].post.requestBody.content['application/json'].schema
  expect(createReqBody.required).toContain('title')

  // CRUD select response exposes id and title
  const listRespSchema =
    spec.paths['/api/posts'].get.responses['200'].content['application/json']
      .schema
  expect(listRespSchema.properties.items.items.properties.title).toBeDefined()

  // 2. Client code generation via openapi-typescript
  const tmpDir = await mkdtemp(join(tmpdir(), 'bunderstack-openapi-gen-'))
  const specPath = join(tmpDir, 'openapi.json')
  const clientPath = join(tmpDir, 'client.d.ts')
  const testConsumerPath = join(tmpDir, 'consumer.ts')

  try {
    await Bun.write(specPath, JSON.stringify(spec, null, 2))

    // Run pinned local openapi-typescript binary
    const genProc = Bun.spawnSync(
      ['bunx', 'openapi-typescript', specPath, '-o', clientPath],
      {
        cwd: process.cwd(),
      },
    )
    expect(genProc.exitCode, genProc.stderr.toString()).toBe(0)

    // Write a consumer TypeScript file referencing CRUD body, custom response, and auth path
    const consumerCode = `
      import type { paths, components } from './client.d.ts'

      // Type-check CRUD create request body
      type CreatePostInput = paths['/api/posts']['post']['requestBody']['content']['application/json']
      const postInput: CreatePostInput = { id: 'p1', title: 'Test Post' }

      // Type-check Custom procedure response
      type StatsResponse = paths['/api/stats']['get']['responses']['200']['content']['application/json']
      const statsResp: StatsResponse = { totalPosts: 10 }

      // Type-check generated storage procedure
      type PrepareImageUpload = paths['/api/files/images/presign']['post']
      type PrepareImageBody = PrepareImageUpload['requestBody']['content']['application/json']
      const imageInput: PrepareImageBody = { filename: 'avatar.png', contentType: 'image/png' }

      // Type-check Auth route
      type AuthSignInPath = paths['/api/auth/sign-in/email']['post']

      if (postInput.title !== 'Test Post' || statsResp.totalPosts !== 10 || imageInput.filename !== 'avatar.png') {
        throw new Error('Type assertion failed')
      }
    `
    await Bun.write(testConsumerPath, consumerCode)

    // Type-check generated client consumer using tsc
    const tscProc = Bun.spawnSync(
      [
        'bunx',
        'tsc',
        '--noEmit',
        '--skipLibCheck',
        '--target',
        'esnext',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        testConsumerPath,
      ],
      {
        cwd: process.cwd(),
      },
    )
    const tscOutput =
      (tscProc.stdout?.toString() || '') + (tscProc.stderr?.toString() || '')
    expect(tscProc.exitCode, tscOutput).toBe(0)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
    await app.close()
  }
})
