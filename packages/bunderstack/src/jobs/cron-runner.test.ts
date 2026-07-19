import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { beforeAll, expect, test } from 'bun:test'

import type { BackgroundDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { runCronSlot } from './cron-runner'

let db: LibSQLDatabase<Record<string, never>>

beforeAll(async () => {
  ;({ db } = await createDb(
    {},
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  ))
  const merged = withInternalTables({})
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
})

test('runs one matching cron slot and records success', async () => {
  const seen: Date[] = []
  const slot = Date.UTC(2026, 6, 18, 12, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async ({ scheduledFor }) => {
        seen.push(scheduledFor)
      },
    },
  }

  const result = await runCronSlot({
    db,
    defs,
    ctx: {},
    name: 'hourly',
    slot,
    now: slot,
  })

  expect(result).toEqual({ status: 'succeeded' })
  expect(seen).toEqual([new Date(slot)])
})

test('returns duplicate without running a successful slot twice', async () => {
  let calls = 0
  const slot = Date.UTC(2026, 6, 18, 13, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {
        calls++
      },
    },
  }
  const args = { db, defs, ctx: {}, name: 'hourly', slot, now: slot }

  await expect(runCronSlot(args)).resolves.toEqual({ status: 'succeeded' })
  await expect(runCronSlot(args)).resolves.toEqual({ status: 'duplicate' })
  expect(calls).toBe(1)
})

test('reclaims a failed slot for a later retry', async () => {
  let calls = 0
  const slot = Date.UTC(2026, 6, 18, 14, 0)
  const defs: BackgroundDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {
        calls++
        if (calls === 1) throw new Error('temporary failure')
      },
    },
  }
  const args = { db, defs, ctx: {}, name: 'hourly', slot, now: slot }

  await expect(runCronSlot(args)).rejects.toThrow('temporary failure')
  await expect(runCronSlot(args)).resolves.toEqual({ status: 'succeeded' })
  expect(calls).toBe(2)
})
