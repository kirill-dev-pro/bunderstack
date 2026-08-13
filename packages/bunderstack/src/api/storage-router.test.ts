import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { expect, test } from 'bun:test'

import type { StorageOperations } from '../storage/operations'
import type { BucketStorageRegistry } from '../storage/registry'
import type { ApiContext } from './context'

import { buildStorageApiRouter } from './storage-router'

function context(request: Request): ApiContext {
  return {
    request,
    resHeaders: new Headers(),
    getRawBody: () => request.clone().text(),
    getSession: async () => ({
      user: { id: 'u1', email: 'u1@test.dev', name: 'U1' },
      activeOrganizationId: null,
    }),
  } as ApiContext
}

test('generated bucket procedures preserve upload and nested download HTTP routes', async () => {
  const seen: string[] = []
  const operations = {
    upload: async (_bucket: string, file: File) => {
      seen.push(`upload:${file.name}`)
      return { status: 201 as const, fileId: 'docs/id.txt', url: '/api/files/docs/id.txt' }
    },
    download: async (_bucket: string, path: string) => {
      seen.push(`download:${path}`)
      return {
        kind: 'body' as const,
        status: 200,
        body: new Blob(['hello'], { type: 'text/plain' }),
        headers: new Headers({ 'Content-Type': 'text/plain' }),
      }
    },
  } as unknown as StorageOperations
  const registry = new Map([
    ['docs', { bucket: { name: 'docs' }, adapter: {} }],
  ]) as BucketStorageRegistry
  const router = buildStorageApiRouter(registry, operations)
  const handler = new OpenAPIHandler({ router })

  const form = new FormData()
  form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }))
  const uploadRequest = new Request('http://localhost/api/files/docs', {
    method: 'POST',
    body: form,
  })
  const upload = await handler.handle(uploadRequest, {
    context: context(uploadRequest),
  })
  expect(upload.matched).toBe(true)
  const uploadText = await upload.response?.text()
  const uploadBody = uploadText?.startsWith('{')
    ? JSON.parse(uploadText)
    : uploadText
  expect({ status: upload.response?.status, body: uploadBody }).toEqual({
    status: 201,
    body: {
    fileId: 'docs/id.txt',
    url: '/api/files/docs/id.txt',
    },
  })

  const downloadRequest = new Request(
    'http://localhost/api/files/docs/nested/report.txt',
  )
  const download = await handler.handle(downloadRequest, {
    context: context(downloadRequest),
  })
  expect(download.matched).toBe(true)
  expect(await download.response?.text()).toBe('hello')
  expect(seen).toEqual(['upload:hello.txt', 'download:nested/report.txt'])
})
