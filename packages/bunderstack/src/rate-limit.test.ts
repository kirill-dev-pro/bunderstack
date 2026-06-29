import { test, expect } from 'bun:test'
import { Hono } from 'hono'

import { createRateLimiter } from './rate-limit'

test('rate limiter returns 429 after max requests', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
  const req = new Request('http://localhost/api/posts')

  expect(await limiter(req)).toBeNull()
  expect(await limiter(req)).toBeNull()
  const blocked = await limiter(req)
  expect(blocked?.status).toBe(429)
  const body = (await blocked!.json()) as { code: string }
  expect(body.code).toBe('RATE_LIMITED')
  expect(blocked?.headers.get('Retry-After')).toBeTruthy()
})

test('disabled rate limiter always passes', async () => {
  const limiter = createRateLimiter(false)
  const req = new Request('http://localhost/api/posts')
  expect(await limiter(req)).toBeNull()
})
