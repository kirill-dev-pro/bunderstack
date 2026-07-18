import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeAll, expect, test } from 'bun:test'

import type { BackgroundDefs } from './define'

import { signScheduleRequest } from './cron-auth'
import { buildCronRouter } from './cron-router'
import { createDb } from '../db'
import { withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'

let db: LibSQLDatabase<Record<string, never>>

beforeAll(async () => {
  ;({ db } = await createDb({}, { url: ':memory:', dialect: 'sqlite' }))
  const merged = withInternalTables({})
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
})

function router(defs: BackgroundDefs, now: number) {
  return buildCronRouter({
    db,
    defs,
    ctx: {},
    secret: 'secret',
    storage: { sweep: async () => {} },
    now: () => now,
  })
}

test('rejects a request without a schedule signature', async () => {
  const app = router({}, Date.UTC(2026, 6, 18, 12, 0))
  const response = await app.request('http://localhost/cron/hourly', { method: 'POST' })
  expect(response.status).toBe(401)
})

test('runs a signed cron slot once and returns duplicate on repeat delivery', async () => {
  let calls = 0
  const slot = Date.UTC(2026, 6, 18, 12, 0)
  const app = router(
    {
      hourly: {
        kind: 'cron',
        schedule: '0 * * * *',
        handler: async () => {
          calls++
        },
      },
    },
    slot,
  )
  const headers = {
    'X-Bunderstack-Cron-Slot': String(slot),
    'X-Bunderstack-Cron-Signature': signScheduleRequest(
      'secret',
      'cron:hourly',
      slot,
    ),
  }

  const first = await app.request('http://localhost/cron/hourly', {
    method: 'POST',
    headers,
  })
  expect(first.status).toBe(200)
  await expect(first.json()).resolves.toEqual({ status: 'succeeded' })

  const second = await app.request('http://localhost/cron/hourly', {
    method: 'POST',
    headers,
  })
  expect(second.status).toBe(200)
  await expect(second.json()).resolves.toEqual({ status: 'duplicate' })
  expect(calls).toBe(1)
})

test('runs signed storage maintenance once per schedule slot', async () => {
  const slot = Date.UTC(2026, 6, 18, 4, 0)
  let sweeps = 0
  const app = buildCronRouter({
    db,
    defs: {},
    ctx: {},
    secret: 'secret',
    storage: { sweep: async () => { sweeps++ } },
    now: () => slot,
  })
  const headers = {
    'X-Bunderstack-Cron-Slot': String(slot),
    'X-Bunderstack-Cron-Signature': signScheduleRequest(
      'secret',
      'maintenance:storage-sweep',
      slot,
    ),
  }

  const first = await app.request('http://localhost/maintenance/storage-sweep', {
    method: 'POST',
    headers,
  })
  const second = await app.request('http://localhost/maintenance/storage-sweep', {
    method: 'POST',
    headers,
  })

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(sweeps).toBe(1)
})
