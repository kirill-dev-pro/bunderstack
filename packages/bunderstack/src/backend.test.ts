import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as v from 'valibot'

import type { DatabaseAdapter } from './database/adapter'

import { blueprintFromManifest, serializeBlueprint } from './blueprint'
import { libsql } from './database/libsql'
import { bunderstack } from './index'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })

test('bunderstack is synchronous and does not connect', () => {
  let connects = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      connects++
      throw new Error('must not connect while declaring')
    },
    async migrate() {},
  }

  const backend = bunderstack({ schema: { notes } }, () => ({
    database: { adapter },
  }))

  expect(connects).toBe(0)
  expect(
    backend.inspect().database.tables.map((table) => table.physicalName),
  ).toContain('notes')
})

test('explicit start env does not inherit process.env', async () => {
  const previous = process.env.ADMIN_TOKEN
  process.env.ADMIN_TOKEN = 'ambient'
  try {
    const backend = bunderstack(
      { schema: { notes }, env: { server: { ADMIN_TOKEN: v.string() } } },
      () => ({
        database: { adapter: libsql() },
      }),
    )

    await expect(
      backend.start({ env: { DATABASE_URL: ':memory:' } }),
    ).rejects.toThrow(/ADMIN_TOKEN/)
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = previous
  }
})

test('a throwing api callback fails during inspection', () => {
  const failure = new Error('router construction failed')

  const backend = bunderstack({ schema: { notes } }, () => ({
    database: { adapter: libsql() },
    api: () => {
      throw failure
    },
  }))
  expect(() => backend.inspect()).toThrow(failure)
})

test('env-first declarations are lazy and inspect each explicit environment', () => {
  const seen: string[] = []
  const backend = bunderstack(
    { schema: { notes }, env: { server: { TENANT: v.string() } } },
    (env) => {
      seen.push(env.TENANT)
      return {
        database: {
          adapter: libsql(),
          migrations: `migrations/${env.TENANT}`,
        },
      }
    },
  )

  expect(seen).toEqual([])
  expect(
    backend.inspect({ env: { TENANT: 'alpha' } }).database.migrationsDirectory,
  ).toBe('migrations/alpha')
  expect(
    backend.inspect({ env: { TENANT: 'beta' } }).database.migrationsDirectory,
  ).toBe('migrations/beta')
  expect(seen).toEqual(['alpha', 'beta'])
})

test('hosted blueprint mismatch fails before connecting to the database', async () => {
  let connects = 0
  const adapter: DatabaseAdapter = {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect() {
      connects++
      throw new Error('must not connect')
    },
    async migrate() {},
  }
  const backend = bunderstack({ schema: { notes } }, () => ({
    database: { adapter },
  }))
  const directory = await mkdtemp(join(tmpdir(), 'bunderstack-contract-'))
  const path = join(directory, 'bunderstack.blueprint.yaml')
  const blueprint = blueprintFromManifest({
    manifest: backend.inspect({ env: {} }),
    generatorVersion: 'test',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
  })
  blueprint.resources.realtime = { required: true }
  await Bun.write(path, serializeBlueprint(blueprint))
  try {
    await expect(
      backend.start({ env: { BUNDERSTACK_BLUEPRINT_PATH: path } }),
    ).rejects.toThrow(/realtime\.required/)
    expect(connects).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
