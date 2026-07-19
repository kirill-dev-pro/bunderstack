import { test, expect } from 'bun:test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

import { libsql } from './database/libsql'
import { createDb } from './db'
import { provisionSchema } from './provision'

const widgets = sqliteTable('provision_test_widgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
})

test('provisionSchema pushes schema to in-memory sqlite', async () => {
  const schema = { widgets }
  const { db } = await createDb(schema, {
    url: ':memory:',
    dialect: 'sqlite',
    adapter: libsql(),
  })
  await provisionSchema(db, schema, { force: true })

  const [row] = await db.insert(widgets).values({ label: 'ok' }).returning()
  expect(row?.label).toBe('ok')
})
