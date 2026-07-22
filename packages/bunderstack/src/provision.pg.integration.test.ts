import { test, expect } from 'bun:test'
import { sql } from 'drizzle-orm'
import { bigint, pgTable, serial, text } from 'drizzle-orm/pg-core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pglite } from './database/pglite'
import { createBunderstack } from './index'
import { provision } from './provision'

const widgets = pgTable('provision_pg_widgets', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }),
})

test('provision pushes a pg schema to PGlite when no migrations exist', async () => {
  const app = await createBunderstack({
    schema: { widgets },
    database: {
      url: 'memory://',
      migrations: './does-not-exist-migrations',
      adapter: pglite(),
    },
  })

  await provision(app, { force: true })

  const [row] = await app.db.insert(widgets).values({ label: 'ok' }).returning()
  expect(row?.label).toBe('ok')
})

test('provision applies committed pg migrations instead of pushing', async () => {
  const dir = join(
    process.cwd(),
    `.test-pg-migrations-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(join(dir, 'meta'), { recursive: true })
  await writeFile(
    join(dir, '0000_init.sql'),
    'CREATE TABLE migrated_pg_widgets (id integer PRIMARY KEY, label text NOT NULL);',
  )
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        {
          idx: 0,
          version: '7',
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
      database: { url: 'memory://', migrations: dir, adapter: pglite() },
    })

    await provision(app)

    const migrated = (await app.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'migrated_pg_widgets'`)) as { rows: unknown[] }
    expect(migrated.rows.length).toBe(1)
    const pushed = (await app.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'provision_pg_widgets'`)) as { rows: unknown[] }
    expect(pushed.rows.length).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
