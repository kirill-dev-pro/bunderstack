import { beforeAll, expect, test } from 'bun:test'
import { pgTable, text } from 'drizzle-orm/pg-core'

import type { BackgroundDefs } from './define'

import { pglite } from '../database/pglite'
import { createDb } from '../db'
import { withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { runCronSlot } from './cron-runner'

const marker = pgTable('cron_pg_marker', { id: text('id').primaryKey() })
let db: Awaited<ReturnType<typeof createDb>>['db']

beforeAll(async () => {
  ;({ db } = await createDb(
    { marker },
    { url: 'memory://', dialect: 'pg', adapter: pglite() },
  ))
  await provisionSchema(db as never, withInternalTables({ marker }), {
    force: true,
  })
})

test('pg: successful slot is persisted and deduplicated', async () => {
  let calls = 0
  const slot = Date.UTC(2026, 6, 18, 15, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {
        calls++
      },
    },
  }
  const args = {
    db: db as never,
    defs,
    ctx: {},
    name: 'hourly',
    slot,
    now: slot,
  }

  await expect(runCronSlot(args)).resolves.toEqual({ status: 'succeeded' })
  await expect(runCronSlot(args)).resolves.toEqual({ status: 'duplicate' })
  expect(calls).toBe(1)
})
