// src/workers/rate-limiter.ts — one Durable Object per client+path key. Its
// memory is the window; a reset after eviction only forgives a few requests.
import type { RateLimitStore } from '../platform'
import type {
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
} from './types'

import { createMemoryRateLimitStore } from '../platform'
import { stub } from './types'

type HitRequest = { windowMs: number; max: number; now: number }

export class RateLimiter {
  private readonly store = createMemoryRateLimitStore()

  constructor(_state: DurableObjectStateLike, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const { windowMs, max, now } = (await request.json()) as HitRequest
    return Response.json(await this.store.hit('window', windowMs, max, now))
  }
}

export function durableRateLimitStore(
  namespace: DurableObjectNamespaceLike,
): RateLimitStore {
  return {
    async hit(key, windowMs, max, now = Date.now()) {
      const res = await stub(namespace, key).fetch('https://rate-limiter/hit', {
        method: 'POST',
        body: JSON.stringify({ windowMs, max, now } satisfies HitRequest),
      })
      return res.json()
    },
  }
}
