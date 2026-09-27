import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { libsql } from '../database/libsql'
import { bunderstack } from '../index'
import { provision } from '../provision-schema'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

function backend() {
  return bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    jobs: (j) =>
      j.define({
        work: j.job({
          input: v.object({ n: v.number() }),
          handler: async () => {},
        }),
        tick5: j.cron({ schedule: '*/5 * * * *', handler: async () => {} }),
      }),
  })
}

test('enqueue notifies the platform with the run time', async () => {
  const seen: number[] = []
  const app = await backend().start({
    env: { DATABASE_URL: ':memory:' },
    platform: { jobs: { notify: (runAt) => void seen.push(runAt) } },
  })
  try {
    await provision(app, { force: true })
    const before = Date.now()
    await app.jobs.enqueue('work', { n: 1 }, { delay: 60_000 })
    expect(seen.length).toBe(1)
    expect(seen[0]!).toBeGreaterThanOrEqual(before + 60_000)
    expect(seen[0]!).toBeLessThanOrEqual(Date.now() + 60_000)
  } finally {
    await app.close()
  }
})

test('a failing notify does not fail the enqueue', async () => {
  const app = await backend().start({
    env: { DATABASE_URL: ':memory:' },
    platform: {
      jobs: {
        notify: () => {
          throw new Error('scheduler is down')
        },
      },
    },
  })
  try {
    await provision(app, { force: true })
    await expect(app.jobs.enqueue('work', { n: 1 })).resolves.toEqual({
      id: expect.any(String),
    })
  } finally {
    await app.close()
  }
})

test('app.jobs.nextDueAt reports the next cron slot', async () => {
  const app = await backend().start({ env: { DATABASE_URL: ':memory:' } })
  try {
    await provision(app, { force: true })
    const now = Date.UTC(2026, 0, 1, 0, 1, 30)
    expect(await app.jobs.nextDueAt(now)).toBe(Date.UTC(2026, 0, 1, 0, 5))
  } finally {
    await app.close()
  }
})
