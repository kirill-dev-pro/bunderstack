import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { WorkerEnv } from './types'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { createFakeNamespace } from '../testing/workers-fakes'
import { createWorker } from './index'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })
const ctx = () => {
  const pending: Promise<unknown>[] = []
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), pending }
}

function backendWithJobs() {
  return bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    jobs: (j) =>
      j.define({
        beat: j.cron({ schedule: '* * * * *', handler: async () => {} }),
      }),
  })
}

test('fetch serves the API and falls back to assets on 404', async () => {
  const worker = createWorker(backendWithJobs())
  const env = {
    DATABASE_URL: ':memory:',
    ASSETS: { fetch: async () => new Response('<html>spa</html>') },
  }
  const health = await worker.handler.fetch(
    new Request('https://app.test/api/health'),
    env,
    ctx(),
  )
  expect(health.status).toBe(200)
  const page = await worker.handler.fetch(
    new Request('https://app.test/boards/1'),
    env,
    ctx(),
  )
  expect(await page.text()).toBe('<html>spa</html>')
})

test('a failed start is retried by the next request', async () => {
  const backend = backendWithJobs()
  let calls = 0
  const failing = {
    ...backend,
    start: async () => {
      calls++
      throw new Error('database is down')
    },
  } as unknown as typeof backend
  const worker = createWorker(failing)
  const request = () => new Request('https://app.test/api/health')
  await expect(worker.handler.fetch(request(), {}, ctx())).rejects.toThrow(
    'database is down',
  )
  await expect(worker.handler.fetch(request(), {}, ctx())).rejects.toThrow(
    'database is down',
  )
  expect(calls).toBe(2)
})

test('scheduled wakes the Scheduler', async () => {
  const worker = createWorker(backendWithJobs())
  const env: WorkerEnv = { DATABASE_URL: ':memory:' }
  const SCHEDULER = createFakeNamespace(
    (state) => new worker.durableObjects.Scheduler(state, env),
  )
  env.SCHEDULER = SCHEDULER
  const c = ctx()
  const before = Date.now()
  await worker.handler.scheduled({}, env, c)
  await Promise.all(c.pending)
  expect(SCHEDULER.state('main').alarmAt()).toBeGreaterThanOrEqual(before)
})
