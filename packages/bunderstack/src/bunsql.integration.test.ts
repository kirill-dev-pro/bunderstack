// src/bunsql.integration.test.ts — end-to-end against a real Postgres server.
// Skipped unless TEST_POSTGRES_URL is set, e.g.:
//   TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres bun test src/bunsql.integration.test.ts
//
// Uses committed migrations (drizzle-orm's own migrator), not dev push:
// drizzle-kit@0.30's pushSchema assumes raw query results have a `.rows`
// property (true for node-postgres/postgres-js/pglite), but Bun.sql's
// `execute()` returns a plain array — a drizzle-kit/Bun.sql interop gap, not a
// bunderstack bug. The migrate path is pure drizzle-orm (PgDialect.migrate)
// and doesn't depend on that shape, so it works for every pg driver.
import { test, expect } from 'bun:test'
import { sql } from 'drizzle-orm'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createBunderstack } from './index'
import { provision } from './provision'

const url = process.env.TEST_POSTGRES_URL

const widgets = pgTable('bunsql_it_widgets', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
})

test.skipIf(!url)(
  'createBunderstack + provision (migrate) work against real Postgres via Bun.sql',
  async () => {
    const dir = join(
      process.cwd(),
      `.test-bunsql-migrations-${Math.random().toString(36).slice(2)}`,
    )
    await mkdir(join(dir, 'meta'), { recursive: true })
    await writeFile(
      join(dir, '0000_init.sql'),
      'CREATE TABLE IF NOT EXISTS bunsql_it_widgets (id serial PRIMARY KEY, label text NOT NULL);',
    )
    await writeFile(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: Date.now(), tag: '0000_init', breakpoints: true },
        ],
      }),
    )

    const app = await createBunderstack({
      schema: { widgets },
      database: { url: url!, migrations: dir },
    })

    try {
      // Clean slate: drop leftovers from previous runs before migrating.
      await app.db.execute(sql`DROP TABLE IF EXISTS bunsql_it_widgets`)
      await app.db.execute(sql`DROP TABLE IF EXISTS __drizzle_migrations`)
      await provision(app)

      const [row] = await app.db
        .insert(widgets)
        .values({ label: 'real-pg' })
        .returning()
      expect(row?.label).toBe('real-pg')
    } finally {
      await app.db.execute(sql`DROP TABLE IF EXISTS bunsql_it_widgets`)
      await app.db.execute(sql`DROP TABLE IF EXISTS __drizzle_migrations`)
      await rm(dir, { recursive: true, force: true })
    }
  },
)
