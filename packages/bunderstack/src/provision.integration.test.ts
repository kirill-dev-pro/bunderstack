import { test, expect } from 'bun:test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

import { createBunderstack } from './index'

const widgets = sqliteTable('provision_widgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
})

test('provision pushes schema to in-memory sqlite', async () => {
  const app = createBunderstack({
    schema: { widgets },
    database: { url: ':memory:' },
  })

  await app.provision({ force: true })

  const [row] = await app.db.insert(widgets).values({ label: 'ok' }).returning()
  expect(row?.label).toBe('ok')
})
