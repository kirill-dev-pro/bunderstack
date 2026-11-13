import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  integer as pgInteger,
  pgTable,
  serial,
  text as pgText,
} from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { DatabaseAdapter } from './database/adapter'

import { bunSqlite } from './database/bun-sqlite'
import { libsql } from './database/libsql'
import { pglite } from './database/pglite'
import { bunderstack } from './index'
import { bunderstackSeed } from './internal-tables'
import { bunderstackSeedPg } from './internal-tables-pg'
import { provision } from './provision-schema'
import { defineSeed, isSeedDefinition, type SeedDefinition } from './seed'
import { seedRequested } from './seed-request'
import {
  SeedFailedError,
  isLocalDatabaseUrl,
  resetSeededDatabase,
  runSeed,
  seedIfAsked,
} from './seed-runtime'
import { BUNDERSTACK_VERSION } from './version'

const users = sqliteTable('seed_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})
const orders = sqliteTable('seed_orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  total: integer('total').notNull(),
})
const schema = { users, orders }

/** A backend whose seed is whatever `seed.current` holds when it is loaded. */
function application(adapter: DatabaseAdapter) {
  const seed: { current?: SeedDefinition; loads: number } = { loads: 0 }
  const backend = bunderstack({
    schema,
    database: {
      adapter,
      seed: async () => {
        seed.loads++
        return { default: seed.current }
      },
    },
  })
  seed.current = defineSeed(backend, async ({ db, schema }) => {
    const [ada] = await db
      .insert(schema.users)
      .values({ name: 'Ada' })
      .returning()
    await db.insert(schema.orders).values({ userId: ada!.id, total: 4200 })
  })
  return { backend, seed }
}

for (const [name, adapter] of [
  ['libsql', libsql],
  ['bun:sqlite', bunSqlite],
] as const) {
  test(`${name}: a database is seeded once`, async () => {
    const { backend, seed } = application(adapter())
    await using fixture = await backend.test({ database: { schema: 'push' } })
    const { db } = fixture.app

    expect(await runSeed(fixture.app)).toBe('seeded')
    expect(await db.select().from(users)).toEqual([{ id: 1, name: 'Ada' }])
    expect(await db.select().from(orders)).toEqual([
      { id: 1, userId: 1, total: 4200 },
    ])
    const [mark] = await db.select().from(bunderstackSeed)
    expect(mark).toMatchObject({
      id: 'seed',
      version: BUNDERSTACK_VERSION,
      revision: null,
    })
    expect(mark!.seededAt).toBeGreaterThan(Date.now() - 60_000)

    // A restart, a redeploy: the mark is there, the seed does not run.
    expect(await runSeed(fixture.app)).toBe('already-seeded')
    expect(await db.select().from(users)).toHaveLength(1)
    expect(seed.loads).toBe(2)
  })

  test(`${name}: a seed that fails keeps nothing, and the next one starts clean`, async () => {
    const { backend, seed } = application(adapter())
    const working = seed.current!
    seed.current = defineSeed(backend, async ({ db, schema }) => {
      await db.insert(schema.users).values({ name: 'Half' })
      throw new Error('the fixture file is missing')
    })
    await using fixture = await backend.test({ database: { schema: 'push' } })
    const { db } = fixture.app

    const failure = await runSeed(fixture.app).catch((error) => error)
    expect(failure).toBeInstanceOf(SeedFailedError)
    expect(failure.message).toBe(
      '[bunderstack] the seed failed, and nothing it wrote was kept: the fixture file is missing',
    )
    expect(await db.select().from(users)).toEqual([])
    expect(await db.select().from(bunderstackSeed)).toEqual([])

    seed.current = working
    expect(await runSeed(fixture.app)).toBe('seeded')
    expect(await db.select().from(users)).toEqual([{ id: 1, name: 'Ada' }])
  })

  test(`${name}: a seed that breaks the schema's own rules keeps nothing`, async () => {
    const { backend, seed } = application(adapter())
    seed.current = defineSeed(backend, async ({ db, schema }) => {
      await db.insert(schema.users).values({ name: 'Ada' })
      // No such user: the foreign key refuses it.
      await db.insert(schema.orders).values({ userId: 404, total: 1 })
    })
    await using fixture = await backend.test({ database: { schema: 'push' } })
    await fixture.app.db.run(sql`PRAGMA foreign_keys = ON`)

    await expect(runSeed(fixture.app)).rejects.toBeInstanceOf(SeedFailedError)
    expect(await fixture.app.db.select().from(users)).toEqual([])
  })

  test(`${name}: a transaction inside the seed is a savepoint`, async () => {
    const { backend, seed } = application(adapter())
    seed.current = defineSeed(backend, async ({ db, schema }) => {
      await db.insert(schema.users).values({ name: 'kept' })
      await db.transaction(async (inner) => {
        await inner.insert(schema.users).values({ name: 'kept too' })
      })
      await db
        .transaction(async (inner) => {
          await inner.insert(schema.users).values({ name: 'dropped' })
          throw new Error('only this part')
        })
        .catch(() => {})
    })
    await using fixture = await backend.test({ database: { schema: 'push' } })

    expect(await runSeed(fixture.app)).toBe('seeded')
    expect(
      (await fixture.app.db.select().from(users)).map((row) => row.name),
    ).toEqual(['kept', 'kept too'])
  })

  test(`${name}: reset empties the application's tables and lets the seed run again`, async () => {
    const { backend } = application(adapter())
    await using fixture = await backend.test({
      database: { mode: 'temporary', schema: 'push' },
    })
    const { db } = fixture.app
    await db.run(sql`PRAGMA foreign_keys = ON`)
    await runSeed(fixture.app)
    await db.insert(users).values({ name: 'Typed by hand' })

    expect(await resetSeededDatabase(fixture.app)).toEqual([
      'seed_orders',
      'seed_users',
    ])
    expect(await db.select().from(users)).toEqual([])
    expect(await db.select().from(orders)).toEqual([])
    expect(await db.select().from(bunderstackSeed)).toEqual([])

    expect(await runSeed(fixture.app)).toBe('seeded')
    expect(await db.select().from(users)).toHaveLength(1)
  })
}

test('nothing is seeded unless the process was started with BUNDERSTACK_SEED=1', async () => {
  expect(seedRequested({ BUNDERSTACK_SEED: '1' })).toBe(true)
  for (const value of ['true', 'yes', '0', '', ' 1', undefined]) {
    expect(seedRequested({ BUNDERSTACK_SEED: value })).toBe(false)
  }

  const { backend, seed } = application(libsql())
  await using quiet = await backend.test({ database: { schema: 'push' } })
  // `provision` is what an application calls at start.
  await provision(quiet.app)
  expect(await seedIfAsked(quiet.app)).toBe('not-asked')
  expect(await quiet.app.db.select().from(users)).toEqual([])
  // Not asked means not even loaded.
  expect(seed.loads).toBe(0)

  await using asked = await backend.test({
    env: { BUNDERSTACK_SEED: '1', BUNDERSTACK_REVISION: 'abc123' },
    database: { schema: 'push' },
  })
  await provision(asked.app)
  expect(await asked.app.db.select().from(users)).toHaveLength(1)
  expect(await asked.app.db.select().from(bunderstackSeed)).toMatchObject([
    { revision: 'abc123' },
  ])
  // Started again the same way: seeded already.
  await provision(asked.app)
  expect(await asked.app.db.select().from(users)).toHaveLength(1)
})

test('a test fixture starts from the seed only when asked to', async () => {
  const { backend } = application(libsql())
  await using empty = await backend.test({ database: { schema: 'push' } })
  expect(await empty.app.db.select().from(users)).toEqual([])

  await using seeded = await backend.test({
    seed: true,
    database: { schema: 'push' },
  })
  expect(await seeded.app.db.select().from(users)).toEqual([
    { id: 1, name: 'Ada' },
  ])

  const plain = bunderstack({ schema, database: { adapter: libsql() } })
  await expect(
    plain.test({ seed: true, database: { schema: 'push' } }),
  ).rejects.toThrow('needs an application that declares database.seed')
})

test('an application without a seed is left alone even when asked', async () => {
  const backend = bunderstack({ schema, database: { adapter: libsql() } })
  await using fixture = await backend.test({
    env: { BUNDERSTACK_SEED: '1' },
    database: { schema: 'push' },
  })
  expect(await seedIfAsked(fixture.app)).toBe('not-declared')
  expect(backend.inspect().database.seed).toBeUndefined()
})

test('what the seed slot resolves to must be a seed', async () => {
  const backend = bunderstack({
    schema,
    database: {
      adapter: libsql(),
      seed: async () => ({ default: async () => {} }),
    },
  })
  await using fixture = await backend.test({ database: { schema: 'push' } })
  await expect(runSeed(fixture.app)).rejects.toThrow(
    'default export is defineSeed(...)',
  )
  expect(isSeedDefinition(defineSeed(backend, async () => {}))).toBe(true)
  // The definition itself is accepted as well as a module that exports it.
  const direct = bunderstack({
    schema,
    database: {
      adapter: libsql(),
      seed: async () => defineSeed(backend, async () => {}),
    },
  })
  await using second = await direct.test({ database: { schema: 'push' } })
  expect(await runSeed(second.app)).toBe('seeded')
})

test('a transaction the database cut short says what to do about it', () => {
  const cut = new SeedFailedError(
    new Error('Failed query: insert into "users"', {
      cause: new Error('TRANSACTION_TIMEOUT: Transaction timed out'),
    }),
  )
  expect(cut.message).toContain('Transaction timed out.')
  expect(cut.message).toContain('Insert rows in batches')
  expect(new SeedFailedError(new Error('boom')).message).not.toContain(
    'batches',
  )
})

test('a database without the mark table says how to get it', async () => {
  const { backend } = application(libsql())
  await using fixture = await backend.test({ database: { schema: 'push' } })
  await fixture.app.db.run(sql`DROP TABLE _bunderstack_seed`)
  await expect(runSeed(fixture.app)).rejects.toThrow(
    'the table _bunderstack_seed is missing',
  )
})

test('a declared seed is in the manifest, and only then', () => {
  const { backend } = application(libsql())
  expect(backend.inspect().database.seed).toBe(true)
  expect(
    backend
      .inspect()
      .database.tables.find(
        (table) => table.physicalName === '_bunderstack_seed',
      ),
  ).toEqual({
    exportName: '_system.seed',
    physicalName: '_bunderstack_seed',
    system: true,
  })
})

test('only a database on this machine counts as local', () => {
  for (const url of ['file:./data.db', './data.db', ':memory:', 'memory://']) {
    expect(isLocalDatabaseUrl(url)).toBe(true)
  }
  for (const url of [
    'libsql://shop.turso.io',
    'https://bh-shop-prod-db.example.com',
    'http://bh-shop-pr4.sqld.internal:8080',
    'wss://shop.turso.io',
    'postgres://localhost/shop',
    'postgresql://db.example.com/shop',
  ]) {
    expect(isLocalDatabaseUrl(url)).toBe(false)
  }
})

test('reset is refused for a database that is not on this machine', async () => {
  const { backend } = application(libsql())
  await using fixture = await backend.test({ database: { schema: 'push' } })
  const internals = Object.getOwnPropertySymbols(fixture.app)
    .map((symbol) => (fixture.app as never)[symbol] as { databaseUrl?: string })
    .find((value) => value && typeof value.databaseUrl === 'string')!
  internals.databaseUrl = 'libsql://shop.turso.io'
  await expect(resetSeededDatabase(fixture.app)).rejects.toThrow(
    'only against a local database',
  )
})

test('postgres: seeded once, rolled back on failure, emptied by reset', async () => {
  const pgUsers = pgTable('seed_users', {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
  })
  const pgOrders = pgTable('seed_orders', {
    id: serial('id').primaryKey(),
    userId: pgInteger('user_id')
      .notNull()
      .references(() => pgUsers.id),
    total: pgInteger('total').notNull(),
  })
  const seed: { current?: SeedDefinition } = {}
  const backend = bunderstack({
    schema: { users: pgUsers, orders: pgOrders },
    database: {
      adapter: pglite(),
      seed: async () => ({ default: seed.current }),
    },
  })
  const working = defineSeed(backend, async ({ db, schema }) => {
    const [ada] = await db
      .insert(schema.users)
      .values({ name: 'Ada' })
      .returning()
    await db.insert(schema.orders).values({ userId: ada!.id, total: 4200 })
  })
  seed.current = defineSeed(backend, async ({ db, schema }) => {
    await db.insert(schema.users).values({ name: 'Half' })
    await db.insert(schema.orders).values({ userId: 404, total: 1 })
  })
  await using fixture = await backend.test({ database: { schema: 'push' } })
  const { db } = fixture.app

  await expect(runSeed(fixture.app)).rejects.toBeInstanceOf(SeedFailedError)
  expect(await db.select().from(pgUsers)).toEqual([])
  expect(await db.select().from(bunderstackSeedPg)).toEqual([])

  seed.current = working
  expect(await runSeed(fixture.app)).toBe('seeded')
  expect(await runSeed(fixture.app)).toBe('already-seeded')
  expect(
    await db.select().from(pgOrders).where(eq(pgOrders.total, 4200)),
  ).toHaveLength(1)

  await resetSeededDatabase(fixture.app)
  expect(await db.select().from(pgUsers)).toEqual([])
  expect(await db.select().from(bunderstackSeedPg)).toEqual([])
  expect(await runSeed(fixture.app)).toBe('seeded')
  // Identities start over with the tables.
  expect(await db.select().from(pgUsers)).toEqual([{ id: 1, name: 'Ada' }])
})
