// src/workers/registry.ts — the bunderstack Worker of this isolate. A package
// entry registers it; server-side fetch in Start calls it without a network hop.
// The env is the one the Worker last received: it is the same for every request
// in an isolate, and SSR code runs inside a request that reached the Worker.
import type { ExecutionContextLike, WorkerEnv } from './types'

export type RegisteredWorker = {
  fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContextLike,
  ): Promise<Response>
}

let current: RegisteredWorker | undefined
let currentEnv: WorkerEnv | undefined

export function registerWorker(worker: RegisteredWorker): void {
  current = worker
}

export function rememberWorkerEnv(env: WorkerEnv): void {
  currentEnv = env
}

/** The registered Worker and its env, once a request has reached it. */
export function registeredWorker():
  | { worker: RegisteredWorker; env: WorkerEnv }
  | undefined {
  return current && currentEnv
    ? { worker: current, env: currentEnv }
    : undefined
}

export function resetRegistryForTests(): void {
  current = undefined
  currentEnv = undefined
}
