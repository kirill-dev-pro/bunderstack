// tests/storage/multibucket.integration.test.ts
import { test, expect, afterAll } from 'bun:test'
import { rm } from 'node:fs/promises'

import { libsql } from '../database/libsql'
import { createBunderstack } from '../index'
import { provision } from '../provision'

const TMP_DIR = './.tmp-uploads-test'

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

async function buildApp() {
  const app = await createBunderstack({
    schema: {},
    database: { url: ':memory:', adapter: libsql() },
    storage: {
      local: TMP_DIR,
      defaultBucket: 'docs',
      buckets: {
        docs: {
          visibility: 'private',
          access: { create: 'public', get: 'public', delete: 'public' },
        },
      },
    },
  })
  await provision(app, { force: true })
  return app
}

function uploadForm(name: string, body: string): FormData {
  const form = new FormData()
  form.append('file', new File([body], name, { type: 'text/plain' }))
  return form
}

test('multi-bucket upload → get → delete via app.handler', async () => {
  const app = await buildApp()

  // Upload (proxy, since local has no presign).
  const postRes = await app.handler(
    new Request('http://localhost/api/files/docs', {
      method: 'POST',
      body: uploadForm('hello.txt', 'hello world'),
    }),
  )
  expect(postRes.status).toBe(201)
  const { fileId, url } = (await postRes.json()) as {
    fileId: string
    url: string
  }
  expect(fileId.startsWith('docs/')).toBe(true)

  // Get it back.
  const getRes = await app.handler(
    new Request(`http://localhost${url}`, { method: 'GET' }),
  )
  expect(getRes.status).toBe(200)
  expect(await getRes.text()).toBe('hello world')

  // Delete (204), then GET 404.
  const delRes = await app.handler(
    new Request(`http://localhost${url}`, { method: 'DELETE' }),
  )
  expect(delRes.status).toBe(204)

  const getAfter = await app.handler(
    new Request(`http://localhost${url}`, { method: 'GET' }),
  )
  expect(getAfter.status).toBe(404)
})

test('app.storage.delete removes the meta row', async () => {
  const app = await buildApp()

  const postRes = await app.handler(
    new Request('http://localhost/api/files/docs', {
      method: 'POST',
      body: uploadForm('keep.txt', 'data'),
    }),
  )
  expect(postRes.status).toBe(201)
  const { fileId, url } = (await postRes.json()) as {
    fileId: string
    url: string
  }

  await app.storage.delete(fileId)

  const getAfter = await app.handler(
    new Request(`http://localhost${url}`, { method: 'GET' }),
  )
  expect(getAfter.status).toBe(404)
})

test('app.storage.bucket returns the adapter for a declared bucket', async () => {
  const app = await buildApp()
  expect(app.storage.bucket('docs')).toBeDefined()
  expect(app.storage.bucket('nope')).toBeUndefined()
})
