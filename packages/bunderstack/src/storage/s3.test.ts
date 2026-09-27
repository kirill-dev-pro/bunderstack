import { expect, test } from 'bun:test'

import { S3StorageAdapter } from './s3'

type Seen = { method: string; url: string; headers: Headers; body: string }

function fakeS3(respond: (seen: Seen) => Response | Promise<Response>): {
  fetch: typeof fetch
  seen: Seen[]
} {
  const seen: Seen[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    }
    seen.push(entry)
    return respond(entry)
  }) as typeof fetch
  return { fetch: f, seen }
}

const config = {
  bucket: 'media',
  region: 'auto',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  endpoint: 'https://storage.example.test',
}

test('upload PUTs the bytes with the content type and a signature', async () => {
  const s3 = fakeS3(() => new Response(null, { status: 200 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  await adapter.upload(
    'media/a.txt',
    new TextEncoder().encode('hi').buffer,
    'text/plain',
  )
  expect(s3.seen[0]!.method).toBe('PUT')
  expect(s3.seen[0]!.url).toBe('https://storage.example.test/media/media/a.txt')
  expect(s3.seen[0]!.headers.get('content-type')).toBe('text/plain')
  expect(s3.seen[0]!.headers.get('authorization')).toStartWith(
    'AWS4-HMAC-SHA256 ',
  )
  expect(s3.seen[0]!.body).toBe('hi')
})

test('upload throws on a non-2xx answer', async () => {
  const s3 = fakeS3(() => new Response('denied', { status: 403 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  await expect(
    adapter.upload('media/a.txt', new ArrayBuffer(1), 'text/plain'),
  ).rejects.toThrow(/403/)
})

test('get streams the object with its stored content type', async () => {
  const s3 = fakeS3(
    () => new Response('bytes', { headers: { 'content-type': 'image/png' } }),
  )
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  const res = await adapter.get('media/p.png')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(await res.text()).toBe('bytes')
})

test('get answers 404 when the object is missing', async () => {
  const s3 = fakeS3(() => new Response('<Error/>', { status: 404 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  expect((await adapter.get('media/none')).status).toBe(404)
})

test('stat and exists use HEAD', async () => {
  const s3 = fakeS3((seen) =>
    seen.url.endsWith('/missing')
      ? new Response(null, { status: 404 })
      : new Response(null, {
          headers: { 'content-length': '42', 'content-type': 'image/jpeg' },
        }),
  )
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  expect(await adapter.stat('media/x.jpg')).toEqual({
    size: 42,
    contentType: 'image/jpeg',
  })
  expect(await adapter.stat('media/missing')).toBeNull()
  expect(await adapter.exists('media/x.jpg')).toBe(true)
  expect(s3.seen.every((s) => s.method === 'HEAD')).toBe(true)
})

test('delete sends DELETE', async () => {
  const s3 = fakeS3(() => new Response(null, { status: 204 }))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  await adapter.delete('media/a.txt')
  expect(s3.seen[0]!.method).toBe('DELETE')
})

test('list follows continuation tokens and decodes XML entities', async () => {
  const pages = [
    `<ListBucketResult><Contents><Key>media/a__transforms/x&amp;y.webp</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>`,
    `<ListBucketResult><Contents><Key>media/a__transforms/z.webp</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
  ]
  const s3 = fakeS3(() => new Response(pages.shift()!))
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  expect(await adapter.list('media/a__transforms/')).toEqual([
    'media/a__transforms/x&y.webp',
    'media/a__transforms/z.webp',
  ])
  const second = new URL(s3.seen[1]!.url)
  expect(second.searchParams.get('list-type')).toBe('2')
  expect(second.searchParams.get('continuation-token')).toBe('t1')
})

test('presignPut and presignGet sign without network', async () => {
  const s3 = fakeS3(() => {
    throw new Error('presign must not call fetch')
  })
  const adapter = new S3StorageAdapter({ ...config, fetch: s3.fetch })
  const put = new URL(
    await adapter.presignPut('media/a.jpg', { expiresIn: 900 }),
  )
  const get = new URL(
    await adapter.presignGet('media/a.jpg', { expiresIn: 900 }),
  )
  expect(put.pathname).toBe('/media/media/a.jpg')
  expect(put.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  expect(put.searchParams.get('X-Amz-Signature')).not.toBe(
    get.searchParams.get('X-Amz-Signature'),
  )
})

test('publicUrlFor joins the public base and the key', () => {
  const adapter = new S3StorageAdapter({
    ...config,
    publicUrl: 'https://cdn.test/',
  })
  expect(adapter.publicUrlFor('media/a.jpg')).toBe(
    'https://cdn.test/media/a.jpg',
  )
  expect(new S3StorageAdapter(config).publicUrlFor('media/a.jpg')).toBe(
    undefined,
  )
})
