// src/workers/scheduler.ts — the only place background work runs in a Worker.
// One instance per app ('main'). Its alarm chain follows app.jobs.nextDueAt;
// enqueues and Cron Triggers pull the alarm earlier through /notify.
import type { BunderstackBackend } from '../backend'
import type { DurableObjectStateLike, WorkerEnv } from './types'

import { appFor, type WorkerApp } from './app'

export const TICK_BUDGET_MS = 25_000
export const NOTIFY_RETRY_MS = 1_000
export const SAFETY_MS = 3_600_000
export const MIN_GAP_MS = 1_000

export interface SchedulerObject {
  fetch(request: Request): Promise<Response>
  alarm(): Promise<void>
}

export type SchedulerClass = new (
  state: DurableObjectStateLike,
  env: WorkerEnv,
) => SchedulerObject

// An explicit return type keeps the private members out of the emitted .d.ts.
export function createSchedulerClass(
  backend: BunderstackBackend<any>,
): SchedulerClass {
  return class Scheduler {
    private notified = false
    private retried = false

    constructor(
      private readonly state: DurableObjectStateLike,
      private readonly env: WorkerEnv,
    ) {}

    private app(): Promise<WorkerApp> {
      // Enqueues from job handlers move this alarm directly, not via a stub.
      return appFor(backend, this.env, 'scheduler', {
        jobs: { notify: (runAt) => this.schedule(runAt) },
      })
    }

    /** Only ever moves the alarm earlier. */
    private async schedule(runAt: number) {
      const current = await this.state.storage.getAlarm()
      if (current === null || runAt < current) {
        await this.state.storage.setAlarm(runAt)
      }
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname !== '/notify' || request.method !== 'POST') {
        return new Response('Not found', { status: 404 })
      }
      const { runAt } = (await request.json()) as { runAt: number }
      this.notified = true
      this.retried = false
      await this.schedule(runAt)
      return new Response(null, { status: 204 })
    }

    async alarm(): Promise<void> {
      // Clear the alarm that fired, so schedule() below can set a later one.
      // Cloudflare has already cleared it; celld and the test fake may not.
      const fired = await this.state.storage.getAlarm()
      if (fired !== null && fired <= Date.now()) {
        await this.state.storage.deleteAlarm()
      }
      const app = await this.app()
      const started = Date.now()
      let claimed = 0
      for (;;) {
        const result = await app.jobs.tick(Date.now())
        claimed += result.claimed
        if (result.claimed === 0 || Date.now() - started > TICK_BUDGET_MS) {
          break
        }
      }
      const now = Date.now()
      // An enqueue inside a transaction notifies before its commit.
      if (this.notified && claimed === 0 && !this.retried) {
        this.retried = true
        await this.schedule(now + NOTIFY_RETRY_MS)
        return
      }
      this.notified = false
      const next = await app.jobs.nextDueAt(now, now + SAFETY_MS)
      await this.schedule(Math.max(next ?? now + SAFETY_MS, now + MIN_GAP_MS))
    }
  }
}
