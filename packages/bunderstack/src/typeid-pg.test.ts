import { test, expect } from 'bun:test'
import { is } from 'drizzle-orm'
import { PgTable, pgTable } from 'drizzle-orm/pg-core'

import { generate } from './typeid'
import { typeid as typeidPg } from './typeid-pg'

test('pg typeid column builds into a pgTable and generates branded ids', () => {
  const table = pgTable('tid_things', {
    id: typeidPg('thing')
      .primaryKey()
      .$defaultFn(() => generate('thing')),
  })
  expect(is(table, PgTable)).toBe(true)
  const id = generate('thing')
  expect(id.startsWith('thing_')).toBe(true)
})

test('pg typeid rejects invalid prefixes', () => {
  expect(() => typeidPg('Bad_Prefix!')).toThrow(/Invalid typeid prefix/)
})

test('schema/pg exports the pg twins under the sqlite names', async () => {
  const mod = await import('./schema-export-pg')
  expect(is(mod.bunderstackFiles, PgTable)).toBe(true)
  expect(is(mod.bunderstackIdempotency, PgTable)).toBe(true)
})
