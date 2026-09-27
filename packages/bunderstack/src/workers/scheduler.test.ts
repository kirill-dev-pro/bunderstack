import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WorkerEnv } from './types'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { provision } from '../provision-schema'
import { createFakeNamespace } from '../testing/workers-fakes'
import { appFor } from './app'
import { createSchedulerClass } from './scheduler'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

async function setup() {
  // A file database: the Worker app and the scheduler app are two clients.
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-scheduler-'))
  const ran: string[] = []
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    jobs: (j) =>
      j.define({
        work: j.job({ handler: async () => void ran.push('work') }),
        beat: j.cron({
          schedule: '0 0 1 1 *',
          handler: async () => void ran.push('beat'),
        }),
      }),
  })
  const Scheduler = createSchedulerClass(backend)
  const env: WorkerEnv = { DATABASE_URL: `file:${join(dir, 'db.sqlite')}` }
  const SCHEDULER = createFakeNamespace((state) => new Scheduler(state, env))
  env.SCHEDULER = SCHEDULER
  const app = await appFor(backend, env, 'fetch')
  await provision(app as never, { force: true })
  return {
    ran,
    app: app as unknown as {
      jobs: { enqueue(name: string): Promise<unknown> }
    },
    scheduler: () => SCHEDULER.instance('main'),
    alarmAt: () => SCHEDULER.state('main').alarmAt(),
    fire: async () => {
      await SCHEDULER.state('main').storage.deleteAlarm()
      await SCHEDULER.instance('main').alarm()
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

const notify = (runAt: number) =>
  new Request('https://scheduler/notify', {
    method: 'POST',
    body: JSON.stringify({ runAt }),
  })

test('enqueue notifies the scheduler, and its alarm runs the job', async () => {
  const s = await setup()
  try {
    const before = Date.now()
    await s.app.jobs.enqueue('work')
    expect(s.alarmAt()).toBeGreaterThanOrEqual(before)
    expect(s.alarmAt()).toBeLessThanOrEqual(Date.now())
    await s.scheduler().alarm()
    expect(s.ran).toEqual(['work'])
    // Next alarm: the yearly cron is beyond the safety window, so the cap.
    expect(s.alarmAt()).toBeGreaterThan(Date.now() + 3_500_000)
  } finally {
    await s.cleanup()
  }
})

test('a notify alarm that finds nothing retries once after a second', async () => {
  const s = await setup()
  try {
    await s.scheduler().fetch(notify(Date.now()))
    const before = Date.now()
    await s.scheduler().alarm()
    expect(s.alarmAt()).toBeGreaterThanOrEqual(before + 1_000)
    expect(s.alarmAt()).toBeLessThan(before + 5_000)
    // Simulate the retry alarm firing: the fake never clears it by itself.
    await s.fire()
    expect(s.alarmAt()).toBeGreaterThan(Date.now() + 3_500_000)
  } finally {
    await s.cleanup()
  }
})

test('a later notify never pushes an earlier alarm back', async () => {
  const s = await setup()
  try {
    const now = Date.now()
    await s.scheduler().fetch(notify(now + 10_000))
    await s.scheduler().fetch(notify(now + 60_000))
    expect(s.alarmAt()).toBe(now + 10_000)
  } finally {
    await s.cleanup()
  }
})
