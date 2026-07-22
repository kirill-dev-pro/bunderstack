import { describe, expect, mock, test } from 'bun:test'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core'

import type { DatabaseAdapter } from './adapter'

import { bunSql } from './bun-sql'
import { libsql } from './libsql'
import { pglite } from './pglite'

mock.module('postgres', () => ({
  default: () => {
    throw new Error('postgres client must not be created during introspection')
  },
}))

const { postgresJs } = await import('./postgres-js')

const sqliteSchema = {
  notes: sqliteTable('notes', {
    id: sqliteText('id').primaryKey(),
  }),
}

const pgSchema = {
  notes: pgTable('notes', {
    id: pgText('id').primaryKey(),
  }),
}

const schemaFor = (dialect: DatabaseAdapter['dialect']) =>
  dialect === 'sqlite' ? sqliteSchema : pgSchema

describe('DatabaseAdapter', () => {
  test('is structural and carries an explicit dialect and driver', async () => {
    const adapter: DatabaseAdapter = {
      dialect: 'sqlite',
      driver: 'libsql',
      connect: async () => ({ db: { isDb: true } }) as any,
      migrate: async () => {},
    }

    expect(adapter.dialect).toBe('sqlite')
    expect(adapter.driver).toBe('libsql')
    expect(
      await adapter.connect({}, { url: 'file:test.db' }, { introspect: false }),
    ).toEqual({ db: { isDb: true } } as any)
  })

  test.each([
    ['libsql', libsql(), 'postgres://must-not-connect'],
    ['pglite', pglite(), 'postgres://must-not-connect'],
    ['bun-sql', bunSql(), 'postgres://user:pass@127.0.0.1:1/app'],
    ['postgres-js', postgresJs(), 'postgres://user:pass@127.0.0.1:1/app'],
  ] as const)(
    '%s adapter uses a mock during introspection',
    async (_name, adapter, url) => {
      const result = await adapter.connect(
        schemaFor(adapter.dialect),
        { url },
        { introspect: true },
      )
      expect(
        typeof (result.db as unknown as { $client: unknown }).$client,
      ).toBe('object')
      expect(result.close).toBeUndefined()
    },
  )
})
