// src/workers/app.ts — one app per isolate and role, built from bindings.
import type { BunderstackBackend } from '../backend'
import type { Platform } from '../platform'
import type { DurableObjectNamespaceLike, WorkerEnv } from './types'

import { workerStorageFactory } from './r2'
import { durableRateLimitStore } from './rate-limiter'
import { HubPublisher } from './realtime-hub'
import { stub } from './types'

export type WorkerApp = {
  handler(request: Request): Promise<Response>
  jobs: {
    tick(now?: number): Promise<{ claimed: number }>
    nextDueAt(now?: number, until?: number): Promise<number | null>
  }
}

export async function notifyScheduler(
  namespace: DurableObjectNamespaceLike,
  runAt: number,
): Promise<void> {
  const res = await stub(namespace, 'main').fetch('https://scheduler/notify', {
    method: 'POST',
    body: JSON.stringify({ runAt }),
  })
  if (!res.ok) {
    throw new Error(`[bunderstack] scheduler notify failed (${res.status})`)
  }
}

export function envStrings(env: WorkerEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export function workerPlatform(env: WorkerEnv): Partial<Platform> {
  const { SCHEDULER, REALTIME, RATE_LIMITER } = env
  return {
    ...(SCHEDULER
      ? {
          jobs: {
            notify: (runAt: number) => notifyScheduler(SCHEDULER, runAt),
          },
        }
      : {}),
    ...(REALTIME
      ? { realtime: new HubPublisher(() => stub(REALTIME, 'main')) }
      : {}),
    ...(RATE_LIMITER ? { rateLimit: durableRateLimitStore(RATE_LIMITER) } : {}),
    storage: workerStorageFactory(env),
  }
}

type AnyBackend = BunderstackBackend<any>
const apps = new WeakMap<AnyBackend, Map<string, Promise<WorkerApp>>>()

export function appFor(
  backend: AnyBackend,
  env: WorkerEnv,
  role: 'fetch' | 'scheduler',
  platform: Partial<Platform> = {},
): Promise<WorkerApp> {
  let byRole = apps.get(backend)
  if (!byRole) apps.set(backend, (byRole = new Map()))
  const cached = byRole.get(role)
  if (cached) return cached
  const started = backend.start({
    env: envStrings(env),
    platform: { ...workerPlatform(env), ...platform },
  }) as Promise<WorkerApp>
  byRole.set(role, started)
  // A failed start must not poison the isolate: the next request retries.
  started.catch(() => byRole.delete(role))
  return started
}
