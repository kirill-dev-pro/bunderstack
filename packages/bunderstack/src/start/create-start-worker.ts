// src/start/create-start-worker.ts — one Worker for a TanStack Start app:
// /api/* to bunderstack, every other path to Start SSR, cron to the Scheduler.
import type { BunderstackBackend } from '../backend'
import type { ExecutionContextLike, WorkerEnv } from '../workers/types'

import { createWorker } from '../workers/index'
import { rememberWorkerEnv } from '../workers/registry'

type StartHandler = (request: Request) => Promise<Response>

export function createStartWorker(
  backend: BunderstackBackend<any>,
  startHandler?: StartHandler,
) {
  const worker = createWorker(backend)
  let start = startHandler
  const handler = {
    async fetch(
      request: Request,
      env: WorkerEnv,
      ctx: ExecutionContextLike,
    ): Promise<Response> {
      // SSR code in this request calls the API through the registered Worker.
      rememberWorkerEnv(env)
      if (new URL(request.url).pathname.startsWith('/api/')) {
        return worker.handler.fetch(request, env, ctx)
      }
      start ??= await defaultStartHandler()
      return start(request)
    },
    scheduled: worker.handler.scheduled,
  }
  return { handler, durableObjects: worker.durableObjects }
}

async function defaultStartHandler(): Promise<StartHandler> {
  const { createStartHandler, defaultStreamHandler } =
    await import('@tanstack/react-start/server')
  return createStartHandler(defaultStreamHandler) as StartHandler
}
