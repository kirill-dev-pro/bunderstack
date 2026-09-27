// src/workers/index.ts — `bunderstack/workers`: run an app as a Worker on
// Cloudflare or celld. See the Workers runtime spec for the binding names.
import type { BunderstackBackend } from '../backend'
import type { ExecutionContextLike, WorkerEnv } from './types'

import { appFor, notifyScheduler } from './app'
import { RateLimiter } from './rate-limiter'
import { RealtimeHub } from './realtime-hub'
import { createSchedulerClass } from './scheduler'

export function createWorker(backend: BunderstackBackend<any>) {
  const handler = {
    async fetch(
      request: Request,
      env: WorkerEnv,
      _ctx: ExecutionContextLike,
    ): Promise<Response> {
      const app = await appFor(backend, env, 'fetch')
      const response = await app.handler(request)
      // A path that reached the Worker but has no route: let the SPA answer.
      if (response.status === 404 && env.ASSETS)
        return env.ASSETS.fetch(request)
      return response
    },
    async scheduled(
      _controller: unknown,
      env: WorkerEnv,
      ctx: ExecutionContextLike,
    ): Promise<void> {
      if (env.SCHEDULER)
        ctx.waitUntil(notifyScheduler(env.SCHEDULER, Date.now()))
    },
  }
  return {
    handler,
    durableObjects: {
      Scheduler: createSchedulerClass(backend),
      RealtimeHub,
      RateLimiter,
    },
  }
}

export {
  createSchedulerClass,
  type SchedulerClass,
  type SchedulerObject,
} from './scheduler'
export { HubPublisher, RealtimeHub } from './realtime-hub'
export { durableRateLimitStore, RateLimiter } from './rate-limiter'
export { bucketBindingName, R2StorageAdapter } from './r2'
export type * from './types'
