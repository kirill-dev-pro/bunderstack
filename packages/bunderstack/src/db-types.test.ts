import { expect, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { BunderstackDb, BunderstackTx } from './db'

const sqliteSchema = {
  notes: sqliteTable('notes', { id: text('id').primaryKey() }),
}

const pgSchema = {
  notes: pgTable('notes', { id: pgText('id').primaryKey() }),
}

test('BunderstackTx accepts the libSQL transaction callback parameter', () => {
  type Db = BunderstackDb<typeof sqliteSchema>
  type Tx = BunderstackTx<typeof sqliteSchema>

  const accepts = (db: Db) =>
    db.transaction(async (tx) => {
      const typed: Tx = tx
      return typed
    })

  expect(typeof accepts).toBe('function')
})

test('BunderstackTx accepts the Postgres transaction callback parameter', () => {
  type Db = BunderstackDb<typeof pgSchema>
  type Tx = BunderstackTx<typeof pgSchema>

  const accepts = (db: Db) =>
    db.transaction(async (tx) => {
      const typed: Tx = tx
      return typed
    })

  expect(typeof accepts).toBe('function')
})

test('BunderstackDb exposes the schema on its query builder', () => {
  type Db = BunderstackDb<typeof sqliteSchema>

  const reads = (db: Db) => db.query.notes.findFirst()

  expect(typeof reads).toBe('function')
})
