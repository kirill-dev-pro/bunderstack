import { expect, test } from 'bun:test'

import { createFakeNamespace } from '../testing/workers-fakes'
import { durableRateLimitStore, RateLimiter } from './rate-limiter'

test('one RateLimiter instance per key counts a fixed window', async () => {
  const namespace = createFakeNamespace((state) => new RateLimiter(state, {}))
  const store = durableRateLimitStore(namespace)
  expect(await store.hit('ip:/api/a', 1000, 1, 0)).toEqual({
    allowed: true,
    resetAt: 1000,
  })
  expect(await store.hit('ip:/api/a', 1000, 1, 10)).toEqual({
    allowed: false,
    resetAt: 1000,
  })
  expect((await store.hit('ip:/api/b', 1000, 1, 10)).allowed).toBe(true)
  expect(await store.hit('ip:/api/a', 1000, 1, 1000)).toEqual({
    allowed: true,
    resetAt: 2000,
  })
})
