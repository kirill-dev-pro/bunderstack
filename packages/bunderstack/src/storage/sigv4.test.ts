import { expect, test } from 'bun:test'

import { presignUrl, signRequest } from './sigv4'

const aws = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}

// AWS documentation, "Authenticating Requests: Using Query Parameters":
// GET examplebucket/test.txt, 2013-05-24T00:00:00Z, 86400 s.
test('presignUrl matches the AWS documented example', async () => {
  const url = await presignUrl({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    credentials: aws,
    expiresIn: 86_400,
    date: new Date('2013-05-24T00:00:00Z'),
  })
  expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
    'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  )
})

// Cross-check with Bun's own S3 presigner on the same instant. Bun is only a
// test oracle here; the implementation under test never calls it.
test('presignUrl agrees with Bun.S3Client for a path-style PUT', async () => {
  const client = new Bun.S3Client({
    ...aws,
    bucket: 'media',
    endpoint: 'https://storage.example.test',
  })
  const oracle = new URL(
    client.presign('uploads/a b+c.jpg', { method: 'PUT', expiresIn: 900 }),
  )
  const amzDate = oracle.searchParams.get('X-Amz-Date')!
  const date = new Date(
    amzDate.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  )
  const ours = new URL(
    await presignUrl({
      method: 'PUT',
      url: `${oracle.origin}${oracle.pathname}`,
      credentials: aws,
      expiresIn: 900,
      date,
    }),
  )
  expect(ours.pathname).toBe(oracle.pathname)
  expect(ours.searchParams.get('X-Amz-Signature')).toBe(
    oracle.searchParams.get('X-Amz-Signature'),
  )
})

test('signRequest returns lowercase headers with a SigV4 authorization', async () => {
  const headers = await signRequest({
    method: 'PUT',
    url: 'https://storage.example.test/media/a.txt',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
    credentials: aws,
    date: new Date('2026-09-27T12:00:00Z'),
  })
  expect(headers['host']).toBe('storage.example.test')
  expect(headers['x-amz-date']).toBe('20260927T120000Z')
  expect(headers['content-type']).toBe('text/plain')
  expect(headers['x-amz-content-sha256']).toBe(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  )
  expect(headers['authorization']).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260927\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  )
})
