import { PGlite } from '@electric-sql/pglite'
import { createProcedureClient } from '@orpc/server'
import { expect, test } from 'bun:test'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'

import { defineApi } from './builder'
import { createApiContext } from './context'
import { listSpec } from './list-procedure'

const logs = pgTable('logs', {
  id: text('id').primaryKey(),
  level: text('level').notNull(),
  createdAt: integer('created_at').notNull(),
})

const schema = { logs }

// Same setup shape as crud-router.test.ts, so both suites use one harness.
async function createDb() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  const db = drizzle(client, { schema })
  for (let i = 1; i <= 5; i++) {
    await db.insert(logs).values({
      id: `log_${i}`,
      level: i % 2 === 0 ? 'error' : 'info',
      createdAt: i,
    })
  }
  return db
}

function createContext(db: unknown) {
  return createApiContext<typeof schema, never>(
    {
      db: db as never,
      env: {} as never,
      storage: {} as never,
      email: {} as never,
      jobs: {} as never,
      realtime: {} as never,
      auth: {} as never,
    },
    new Request('http://localhost/api/logs'),
  )
}

const o = defineApi({ schema })

const logsList = listSpec(logs, {
  filterable: ['level'],
  sortable: ['createdAt'],
  defaultSort: { column: 'createdAt', order: 'desc' },
})

function buildProcedure() {
  return o.public.input(logsList.input).handler(logsList.handler)
}

async function callList(input: unknown) {
  const db = await createDb()
  const client = createProcedureClient(buildProcedure(), {
    context: createContext(db),
  })
  return client(input as never)
}

test('listSpec returns items in the configured default order', async () => {
  const result = await callList({})

  expect(result.items.map((row) => row.id)).toEqual([
    'log_5',
    'log_4',
    'log_3',
    'log_2',
    'log_1',
  ])
})

test('listSpec applies a declared filter', async () => {
  const result = await callList({ filters: { level: 'error' } })

  expect(result.items.map((row) => row.id)).toEqual(['log_4', 'log_2'])
})

test('listSpec reports hasMore and a cursor when the limit truncates', async () => {
  const result = await callList({ limit: 2 })

  expect(result.items).toHaveLength(2)
  expect(result.hasMore).toBe(true)
  expect(typeof result.nextCursor).toBe('string')
})

test('listSpec returns a total when count is requested', async () => {
  const result = await callList({ count: true })

  expect(result.total).toBe(5)
})

test('listSpec rejects a column that is not declared sortable', async () => {
  await expect(callList({ sort: 'level' })).rejects.toThrow()
})

test('listSpec keeps the row type on its output', async () => {
  const db = await createDb()
  const client = createProcedureClient(buildProcedure(), {
    context: createContext(db),
  })

  const result = await client({})

  // Compiles only when the output keeps ListResult<typeof logs.$inferSelect>.
  const level: string = result.items[0]!.level
  const hasMore: boolean = result.hasMore

  expect(level).toBe('info')
  expect(hasMore).toBe(false)
})
