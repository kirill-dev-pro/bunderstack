// src/platform.ts — the services a host supplies to the core. A Worker gives
// Durable Object backed ones; tests and Bun tooling get these defaults.
import type { RealtimePublisher } from './realtime/publisher'
import type { ResolvedBackend } from './storage/buckets'
import type { StorageAdapter } from './storage/index'

import { createAdapter } from './storage/registry'

export interface JobsPlatform {
  /** A job became runnable at `runAt`. The host wakes a tick at that time. */
  notify(runAt: number): void | Promise<void>
}

export type RateLimitHit = { allowed: boolean; resetAt: number }

export interface RateLimitStore {
  hit(
    key: string,
    windowMs: number,
    max: number,
    now?: number,
  ): Promise<RateLimitHit>
}

export type StorageAdapterFactory = (backend: ResolvedBackend) => StorageAdapter

export interface Platform {
  jobs: JobsPlatform
  /** Absent: the runtime uses a process-local memory publisher. */
  realtime?: RealtimePublisher
  rateLimit: RateLimitStore
  storage: StorageAdapterFactory
}

export function createMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return {
    async hit(key, windowMs, max, now = Date.now()) {
      let window = windows.get(key)
      if (!window || window.resetAt <= now) {
        window = { count: 0, resetAt: now + windowMs }
        windows.set(key, window)
      }
      window.count += 1
      return { allowed: window.count <= max, resetAt: window.resetAt }
    },
  }
}

export function resolvePlatform(partial: Partial<Platform> = {}): Platform {
  return {
    jobs: partial.jobs ?? { notify() {} },
    realtime: partial.realtime,
    rateLimit: partial.rateLimit ?? createMemoryRateLimitStore(),
    storage: partial.storage ?? createAdapter,
  }
}
