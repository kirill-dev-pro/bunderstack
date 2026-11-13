// A process that was asked to seed does it at start when the database
// already has every committed migration, the way a host leaves it; with
// migrations still to apply it waits for `provision(app)`.
import { afterEach, expect, test } from 'bun:test'
import {
  integer as pgInteger,
  pgTable,
  text as pgText,
} from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DatabaseAdapter } from './database/adapter'

import { BACKEND_INTERNALS } from './backend-internals'
import { bunSqlite } from './database/bun-sqlite'
import { libsql } from './database/libsql'
import { pglite } from './database/pglite'
import { bunderstack } from './index'
import { bunderstackSeed } from './internal-tables'
import { provision } from './provision'
import { getProvisionInternals } from './provision-runtime'
import { defineSeed, type SeedDefinition } from './seed'
import { SeedFailedError, committedMigrationsApplied } from './seed-runtime'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

const users = sqliteTable('seed_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})
/** The same table one commit later: the second migration adds `plan`. */
const usersWithPlan = sqliteTable('seed_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  plan: text('plan'),
})

const INIT = `CREATE TABLE \`seed_users\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`_bunderstack_seed\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`seeded_at\` integer NOT NULL,
	\`version\` text NOT NULL,
	\`revision\` text
);
`
const ADD_PLAN = 'ALTER TABLE `seed_users` ADD `plan` text;\n'

async function writeMigrations(
  folder: string,
  migrations: { tag: string; when: number; sql: string }[],
  dialect = 'sqlite',
) {
  await Bun.write(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect,
      entries: migrations.map((migration, idx) => ({
        idx,
        version: '6',
        when: migration.when,
        tag: migration.tag,
        breakpoints: true,
      })),
    }),
  )
  for (const migration of migrations) {
    await Bun.write(join(folder, `${migration.tag}.sql`), migration.sql)
  }
}

const first = { tag: '0000_init', when: 1_790_000_000_000, sql: INIT }
const second = { tag: '0001_plan', when: 1_790_000_100_000, sql: ADD_PLAN }

/** An application with committed migrations and a database file of its own. */
async function application(
  adapter: DatabaseAdapter,
  table: typeof users | typeof usersWithPlan = users,
) {
  const directory = await mkdtemp(join(tmpdir(), 'bunderstack-seed-start-'))
  directories.push(directory)
  const migrations = join(directory, 'migrations')
  await writeMigrations(migrations, [first])
  const seed: { current?: SeedDefinition } = {}
  const backend = bunderstack({
    schema: { users: table },
    database: {
      adapter,
      url: `file:${join(directory, 'data.db')}`,
      migrations,
      seed: async () => ({ default: seed.current }),
    },
  })
  seed.current = defineSeed(backend, async ({ db, schema }) => {
    await db.insert(schema.users).values({ name: 'Ada' })
  })
  const start = (env: Record<string, string> = {}) =>
    backend[BACKEND_INTERNALS].start(
      { AUTH_SECRET: 'seed-start-test', BUNDERSTACK_ROLE: 'web', ...env },
      { backgroundAutoStart: false },
    )
  /** What a host does before it starts the application. */
  const migrateAsHost = async () => {
    const app = await start()
    await provision(app)
    await app.close()
  }
  const names = async (app: Awaited<ReturnType<typeof start>>) =>
    (await app.db.select({ name: users.name }).from(users)).map(
      (row) => row.name,
    )
  return { backend, seed, migrations, start, migrateAsHost, names }
}

for (const [name, adapter] of [
  ['libsql', libsql],
  ['bun:sqlite', bunSqlite],
] as const) {
  test(`${name}: with the migrations applied by a host, the seed runs at start`, async () => {
    const s = await application(adapter())
    await s.migrateAsHost()

    // Production, and any process not asked: nothing.
    const quiet = await s.start()
    expect(await s.names(quiet)).toEqual([])
    await quiet.close()

    // The application never calls provision: a preview is seeded anyway.
    const preview = await s.start({
      BUNDERSTACK_SEED: '1',
      BUNDERSTACK_REVISION: 'abc123',
    })
    expect(await s.names(preview)).toEqual(['Ada'])
    expect(await preview.db.select().from(bunderstackSeed)).toMatchObject([
      { id: 'seed', revision: 'abc123' },
    ])
    await preview.close()

    // Redeployed: seeded already.
    const again = await s.start({ BUNDERSTACK_SEED: '1' })
    expect(await s.names(again)).toEqual(['Ada'])
    await again.close()
  })
}

test('a fresh database is left for provision to migrate and seed', async () => {
  const s = await application(libsql())
  const app = await s.start({ BUNDERSTACK_SEED: '1' })
  // No migration has run: there is nothing to seed into, and no error.
  expect(await committedMigrationsApplied(getProvisionInternals(app))).toBe(
    false,
  )
  await provision(app)
  expect(await s.names(app)).toEqual(['Ada'])
  await app.close()
})

test('a migration still to apply holds the seed until provision has applied it', async () => {
  // The database is one migration behind this commit, which adds a column
  // and has a seed that uses it.
  const s = await application(libsql(), usersWithPlan)
  await s.migrateAsHost()
  await writeMigrations(s.migrations, [first, second])
  s.seed.current = defineSeed(s.backend, async ({ db }) => {
    await db.insert(usersWithPlan).values({ name: 'Ada', plan: 'pro' })
  })

  const app = await s.start({ BUNDERSTACK_SEED: '1' })
  // Seeding now would hit a table without the column.
  expect(await app.db.select().from(bunderstackSeed)).toEqual([])
  await provision(app)
  expect(await app.db.select().from(usersWithPlan)).toEqual([
    { id: 1, name: 'Ada', plan: 'pro' },
  ])
  await app.close()
})

test('a seed that fails at start fails the start and keeps nothing', async () => {
  const s = await application(libsql())
  await s.migrateAsHost()
  s.seed.current = defineSeed(s.backend, async ({ db, schema }) => {
    await db.insert(schema.users).values({ name: 'Half' })
    throw new Error('the fixture file is missing')
  })

  const failure = await s
    .start({ BUNDERSTACK_SEED: '1' })
    .catch((error) => error)
  expect(failure).toBeInstanceOf(SeedFailedError)
  expect(failure.message).toContain('the fixture file is missing')

  const after = await s.start()
  expect(await s.names(after)).toEqual([])
  expect(await after.db.select().from(bunderstackSeed)).toEqual([])
  await after.close()
})

test('without a migrations journal nothing says the schema is in place', async () => {
  const seed: { current?: SeedDefinition } = {}
  const backend = bunderstack({
    schema: { users },
    database: {
      adapter: libsql(),
      seed: async () => ({ default: seed.current }),
    },
  })
  seed.current = defineSeed(backend, async ({ db, schema }) => {
    await db.insert(schema.users).values({ name: 'Ada' })
  })
  await using fixture = await backend.test({
    env: { BUNDERSTACK_SEED: '1' },
    database: { schema: 'push' },
  })
  const internals = getProvisionInternals(fixture.app)
  expect(
    await committedMigrationsApplied({
      ...internals,
      migrationsFolder: join(tmpdir(), 'bunderstack-no-such-migrations'),
    }),
  ).toBe(false)
  // The pushed schema is there, but the start did not seed into it.
  expect(await fixture.app.db.select().from(bunderstackSeed)).toEqual([])
})

test('postgres: applied migrations are read from the drizzle schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunderstack-seed-start-pg-'))
  directories.push(directory)
  const migrations = join(directory, 'migrations')
  await writeMigrations(
    migrations,
    [
      {
        tag: '0000_init',
        when: 1_790_000_000_000,
        sql: 'CREATE TABLE "seed_users" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);\n--> statement-breakpoint\nCREATE TABLE "_bunderstack_seed" ("id" text PRIMARY KEY NOT NULL, "seeded_at" bigint NOT NULL, "version" text NOT NULL, "revision" text);\n',
      },
    ],
    'postgresql',
  )
  const pgUsers = pgTable('seed_users', {
    id: pgInteger('id').primaryKey(),
    name: pgText('name').notNull(),
  })
  const backend = bunderstack({
    schema: { users: pgUsers },
    database: { adapter: pglite(), url: 'memory://', migrations },
  })
  const app = await backend[BACKEND_INTERNALS].start(
    { AUTH_SECRET: 'seed-start-test', BUNDERSTACK_ROLE: 'web' },
    { backgroundAutoStart: false },
  )
  const internals = getProvisionInternals(app)
  expect(await committedMigrationsApplied(internals)).toBe(false)
  await provision(app)
  expect(await committedMigrationsApplied(internals)).toBe(true)
  // A newer entry in the journal, not applied yet.
  await writeMigrations(
    migrations,
    [
      { tag: '0000_init', when: 1_790_000_000_000, sql: '' },
      { tag: '0001_next', when: 1_790_000_100_000, sql: '' },
    ],
    'postgresql',
  )
  expect(await committedMigrationsApplied(internals)).toBe(false)
  await app.close()
})
