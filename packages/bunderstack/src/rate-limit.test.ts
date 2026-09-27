import { test, expect } from 'bun:test'

import type { RateLimitStore } from './platform'

import { createRateLimiter } from './rate-limit'

test('rate limiter returns 429 after max requests', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
  const req = new Request('http://localhost/api/posts')

  expect(await limiter(req)).toBeNull()
  expect(await limiter(req)).toBeNull()
  const blocked = await limiter(req)
  expect(blocked?.status).toBe(429)
  const body = (await blocked!.json()) as { code: string }
  expect(body.code).toBe('TOO_MANY_REQUESTS')
  expect(blocked?.headers.get('Retry-After')).toBeTruthy()
})

test('disabled rate limiter always passes', async () => {
  const limiter = createRateLimiter(false)
  const req = new Request('http://localhost/api/posts')
  expect(await limiter(req)).toBeNull()
})

test('rate limiter asks the injected store with client and path', async () => {
  const calls: Array<[string, number, number]> = []
  const store: RateLimitStore = {
    async hit(key, windowMs, max) {
      calls.push([key, windowMs, max])
      return { allowed: false, resetAt: Date.now() + 5_000 }
    },
  }
  const limiter = createRateLimiter({ windowMs: 10_000, max: 3 }, store)
  const res = await limiter(
    new Request('http://localhost/api/posts', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    }),
  )
  expect(calls).toEqual([['203.0.113.9:/api/posts', 10_000, 3]])
  expect(res?.status).toBe(429)
  expect(Number(res?.headers.get('Retry-After'))).toBeGreaterThan(0)
})

test('two limiters do not share counters', async () => {
  const a = createRateLimiter({ windowMs: 60_000, max: 1 })
  const b = createRateLimiter({ windowMs: 60_000, max: 1 })
  const req = () => new Request('http://localhost/api/shared')
  expect(await a(req())).toBeNull()
  expect(await b(req())).toBeNull()
  expect((await a(req()))?.status).toBe(429)
})
