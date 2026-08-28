import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { bunderstack } from '../index'
import { bunSqlite } from './bun-sqlite'

const notes = sqliteTable('bun_sqlite_notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

test('an app on the bun:sqlite adapter provisions and round-trips a row', async () => {
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: bunSqlite() },
  })

  await using fixture = await backend.test({ database: { schema: 'push' } })
  await fixture.app.db.insert(notes).values({ id: 'n1', title: 'first' })

  expect(await fixture.app.db.select().from(notes)).toEqual([
    { id: 'n1', title: 'first' },
  ])
})

test('the bun:sqlite adapter refuses a remote database URL', async () => {
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: bunSqlite(), url: 'libsql://db.turso.io' },
  })

  await expect(backend.start()).rejects.toThrow(/connects to a local file only/)
})
