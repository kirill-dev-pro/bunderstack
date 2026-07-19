import { test, expect } from 'bun:test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { libsql } from './database/libsql'
import { createBunderstack } from './index'
import { provision } from './provision'

const widgets = sqliteTable('provision_widgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
})

test('provision pushes schema when no migrations folder exists', async () => {
  const app = await createBunderstack({
    schema: { widgets },
    database: {
      url: ':memory:',
      migrations: './does-not-exist-migrations',
      adapter: libsql(),
    },
  })

  await provision(app, { force: true })

  const [row] = await app.db.insert(widgets).values({ label: 'ok' }).returning()
  expect(row?.label).toBe('ok')
})

test('provision applies committed migrations instead of pushing', async () => {
  const dir = join(
    process.cwd(),
    `.test-migrations-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(join(dir, 'meta'), { recursive: true })
  await writeFile(
    join(dir, '0000_init.sql'),
    'CREATE TABLE migrated_widgets (id integer PRIMARY KEY, label text NOT NULL);',
  )
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: Date.now(),
          tag: '0000_init',
          breakpoints: true,
        },
      ],
    }),
  )

  try {
    const app = await createBunderstack({
      schema: { widgets },
      database: { url: ':memory:', migrations: dir, adapter: libsql() },
    })

    await provision(app)

    // The migration table exists; the pushed-schema table does not (no push ran).
    const migrated = await app.db.run(
      "SELECT name FROM sqlite_master WHERE name = 'migrated_widgets'",
    )
    expect(migrated.rows.length).toBe(1)
    const pushed = await app.db.run(
      "SELECT name FROM sqlite_master WHERE name = 'provision_widgets'",
    )
    expect(pushed.rows.length).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('provision rejects objects not created by createBunderstack', async () => {
  await expect(provision({})).rejects.toThrow(/createBunderstack/)
})
