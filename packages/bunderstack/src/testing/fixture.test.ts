import { expect, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import type { DatabaseAdapter } from '../database/adapter'

import { bunSql } from '../database/bun-sql'
import { libsql } from '../database/libsql'
import { pglite } from '../database/pglite'
import { bunderstack } from '../index'

const notes = sqliteTable('fixture_notes', {
  id: text('id').primaryKey(),
})

test('fixtures provision independently and dispose lexically', async () => {
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
  })

  await using a = await backend.test({ database: { schema: 'push' } })
  await using b = await backend.test({ database: { schema: 'push' } })

  await a.app.db.insert(notes).values({ id: 'only-a' })
  expect(await b.app.db.select().from(notes)).toEqual([])

  await a.close()
  await a.close()
  expect(await b.app.db.select().from(notes)).toEqual([])
})

test('configured fixtures merge defaults, expose setup context, and defer LIFO cleanup', async () => {
  const adapter = libsql()
  const strategy = adapter.testing!
  const modes: string[] = []
  adapter.testing = {
    async createTarget(options) {
      modes.push(options.mode)
      return strategy.createTarget(options)
    },
  }
  const cleanup: string[] = []
  const backend = bunderstack({
    schema: { notes },
    database: { adapter },
    env: {
      server: {
        FIXTURE_DEFAULT: v.string(),
        FIXTURE_OVERRIDE: v.string(),
      },
    },
  })
  const createFixture = backend.test.configure({
    env: {
      FIXTURE_DEFAULT: 'kept',
      FIXTURE_OVERRIDE: 'default',
    },
    database: { mode: 'temporary', schema: 'push' },
    setup(fixture) {
      fixture.defer(() => cleanup.push('first'))
      fixture.defer(async () => cleanup.push('second'))
      return {
        label: `${fixture.app.env.FIXTURE_DEFAULT}:${fixture.app.env.FIXTURE_OVERRIDE}`,
      }
    },
  })

  await using fixture = await createFixture({
    env: { FIXTURE_OVERRIDE: 'per-test' },
    database: { schema: 'push' },
  })

  expect(fixture.context).toEqual({ label: 'kept:per-test' })
  expect(modes).toEqual(['temporary'])
  await fixture.close()
  await fixture.close()
  expect(cleanup).toEqual(['second', 'first'])
})

test('external adapters refuse production URLs without a strategy', async () => {
  const pgNotes = pgTable('fixture_notes', {
    id: pgText('id').primaryKey(),
  })
  const backend = bunderstack({
    schema: { pgNotes },
    database: { adapter: bunSql() },
  })

  await expect(backend.test()).rejects.toThrow(
    /explicit test database strategy/,
  )
})

test('PGlite fixtures use independent in-memory targets', async () => {
  const pgNotes = pgTable('fixture_notes', {
    id: pgText('id').primaryKey(),
  })
  const backend = bunderstack({
    schema: { pgNotes },
    database: { adapter: pglite() },
  })

  await using a = await backend.test({ database: { schema: 'push' } })
  await using b = await backend.test({ database: { schema: 'push' } })
  await a.app.db.insert(pgNotes).values({ id: 'only-a' })

  expect(await b.app.db.select().from(pgNotes)).toEqual([])
})

test('setup failure disposes its allocated database target once', async () => {
  let disposals = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      throw new Error('runtime creation failed')
    },
    async migrate() {},
    testing: {
      async createTarget() {
        return {
          connection: { url: ':memory:' },
          async [Symbol.asyncDispose]() {
            disposals++
          },
        }
      },
    },
  }
  const backend = bunderstack({
    schema: { notes },
    database: { adapter },
  })

  await expect(backend.test()).rejects.toThrow('runtime creation failed')
  expect(disposals).toBe(1)
})
