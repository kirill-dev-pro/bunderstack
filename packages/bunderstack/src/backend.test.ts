import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { DatabaseAdapter } from './database/adapter'

import { libsql } from './database/libsql'
import { bunderstack } from './index'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

test('bunderstack is synchronous and does not connect', () => {
  let connects = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      connects++
      throw new Error('must not connect while declaring')
    },
    async migrate() {},
  }

  const backend = bunderstack({ schema: { notes }, database: { adapter } })

  expect(connects).toBe(0)
  expect(
    backend.manifest.database.tables.map((table) => table.physicalName),
  ).toContain('notes')
})

test('explicit start env does not inherit process.env', async () => {
  const previous = process.env.ADMIN_TOKEN
  process.env.ADMIN_TOKEN = 'ambient'
  try {
    const backend = bunderstack({
      schema: { notes },
      database: { adapter: libsql() },
      env: { server: { ADMIN_TOKEN: v.string() } },
    })

    await expect(
      backend.start({ env: { DATABASE_URL: ':memory:' } }),
    ).rejects.toThrow(/ADMIN_TOKEN/)
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = previous
  }
})

test('a throwing api callback fails at declaration, not at start', () => {
  const failure = new Error('router construction failed')

  // The callback is resolved inside bunderstack(), so the manifest describes
  // the same router the runtime serves. That moves this failure earlier than
  // it used to be, and nothing else covers the new timing.
  expect(() =>
    bunderstack({
      schema: { notes },
      database: { adapter: libsql() },
      api: () => {
        throw failure
      },
    }),
  ).toThrow(failure)
})
