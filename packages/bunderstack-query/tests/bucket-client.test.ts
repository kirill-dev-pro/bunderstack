import { expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { integer, sqliteTable, text } from 'bunderstack'

import {
  BunderstackApiError,
  createBunderstackQueryClient,
} from '../src/index'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init?: RequestInit) =>
    handler(url, init)) as typeof fetch
}

test('files bucket uploads a file through the proxy route', async () => {
  const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
  const api = createBunderstackQueryClient().withFiles({
    buckets: ['attachments'] as const,
    fetch: mockFetch((url, init) => {
      expect(url).toBe('/api/files/attachments')
      expect(init?.method).toBe('POST')
      expect(init?.credentials).toBe('include')
      expect(init?.headers).toBeUndefined()
      const body = init?.body
      expect(body).toBeInstanceOf(FormData)
      const formFile = (body as FormData).get('file')
      expect(formFile).toBeInstanceOf(File)
      expect((formFile as File).name).toBe(file.name)
      expect((formFile as File).type).toBe(file.type)
      return Response.json(
        {
          fileId: 'attachments/file-1.txt',
          url: '/api/files/attachments/file-1.txt',
        },
        { status: 201 },
      )
    }),
  })

  const uploaded = await api.files.attachments.upload(file)
  expect(uploaded).toEqual({
    fileId: 'attachments/file-1.txt',
    url: '/api/files/attachments/file-1%2Etxt',
    name: 'hello.txt',
  })
})

test('with builds tables and files in one client', () => {
  type Schema = { posts: typeof posts }
  const api = createBunderstackQueryClient<Schema>().with({
    tables: ['posts'] as const,
    buckets: ['attachments'] as const,
  })

  expect(api.posts.keys.all).toEqual(['posts'])
  expect(api.files.attachments.keys.all).toEqual(['files', 'attachments'])
})

test('files bucket supports presigned upload flow', async () => {
  const file = new File(['image'], 'avatar.png', { type: 'image/png' })
  const calls: string[] = []
  const api = createBunderstackQueryClient().withFiles({
    buckets: ['avatars'] as const,
    fetch: mockFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/api/files/avatars/presign') {
        expect(JSON.parse(init?.body as string)).toEqual({
          filename: 'avatar.png',
          contentType: 'image/png',
        })
        return Response.json({
          mode: 'presign',
          fileId: 'avatars/avatar.png',
          uploadUrl: 'https://storage.example/avatar.png',
          method: 'PUT',
          confirmUrl: '/api/files/avatars/avatar.png/confirm',
        })
      }
      if (url === 'https://storage.example/avatar.png') {
        expect(init?.method).toBe('PUT')
        expect(init?.headers).toEqual({ 'Content-Type': 'image/png' })
        expect(init?.body).toBe(file)
        return new Response(null, { status: 200 })
      }
      expect(url).toBe('/api/files/avatars/avatar%2Epng/confirm')
      return Response.json({
        fileId: 'avatars/avatar.png',
        url: '/api/files/avatars/avatar.png',
      })
    }),
  })

  const uploaded = await api.files.avatars.upload(file, { mode: 'presign' })
  expect(uploaded.fileId).toBe('avatars/avatar.png')
  expect(calls).toEqual([
    'POST /api/files/avatars/presign',
    'PUT https://storage.example/avatar.png',
    'POST /api/files/avatars/avatar%2Epng/confirm',
  ])
})

test('files bucket builds urls and deletes by full fileId or relative id', async () => {
  const api = createBunderstackQueryClient().withFiles({
    buckets: ['attachments'] as const,
    fetch: mockFetch((url, init) => {
      expect(url).toBe('/api/files/attachments/file-1%2Etxt')
      expect(init?.method).toBe('DELETE')
      expect(init?.credentials).toBe('include')
      return new Response(null, { status: 204 })
    }),
  })

  expect(api.files.attachments.url('attachments/file-1.txt')).toBe(
    '/api/files/attachments/file-1%2Etxt',
  )
  expect(
    api.files.attachments.url('file-1.txt', { w: 64, h: 64, format: 'webp' }),
  ).toBe('/api/files/attachments/file-1%2Etxt?w=64&h=64&format=webp')

  await api.files.attachments.delete('attachments/file-1.txt')
})

test('files bucket maps server errors to BunderstackApiError', async () => {
  const api = createBunderstackQueryClient().withFiles({
    buckets: ['attachments'] as const,
    fetch: mockFetch(() =>
      Response.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    ),
  })

  await expect(api.files.attachments.delete('file-1.txt')).rejects.toThrow(
    BunderstackApiError,
  )
})

test('files bucket exposes upload and delete mutation options', async () => {
  const queryClient = new QueryClient()
  const api = createBunderstackQueryClient().withFiles({
    buckets: ['attachments'] as const,
    queryClient,
    fetch: mockFetch((url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({
        fileId: 'attachments/file-1.txt',
        url: '/api/files/attachments/file-1.txt',
      })
    }),
  })

  const uploaded = await api.files.attachments
    .uploadMutation()
    .mutationFn!(
      new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      {} as never,
    )
  expect(uploaded.fileId).toBe('attachments/file-1.txt')

  await api.files.attachments.deleteMutation().mutationFn!(
    'file-1.txt',
    {} as never,
  )
})
