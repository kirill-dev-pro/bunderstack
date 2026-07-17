import type { PgDatabase } from 'drizzle-orm/pg-core'

import { test, expect, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { JobsDefs } from './define'

import { createDb } from '../db'
import { bunderstackJobsPg } from '../internal-tables-pg'
import { withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { enqueueJob } from './queue'
import { createJobRunner } from './worker'

// A pg-dialect user table so withInternalTables/detectDialect pick the pg twins.
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
const marker = pgTable('jobs_pg_marker', { id: pgText('id').primaryKey() })

let db: Awaited<ReturnType<typeof createDb>>['db']

beforeAll(async () => {
  ;({ db } = await createDb(
    { marker },
    { url: 'memory://', dialect: 'pg' },
  ))
  const merged = withInternalTables({ marker })
  await provisionSchema(db as never, merged, { force: true })
})

function runner(defs: JobsDefs) {
  const r = createJobRunner({ db: db as never, defs, ctx: {} })
  r.setJobsFacade({
    enqueue: (name, input, opts) =>
      enqueueJob(db as never, defs, name, input, opts),
    tick: (now) => r.tick(now),
  })
  return r
}

test('pg: enqueue, claim, run to succeeded', async () => {
  const seen: unknown[] = []
  const defs: JobsDefs = {
    greet: {
      input: z.object({ name: z.string() }),
      handler: async (input) => {
        seen.push(input)
      },
    },
  }
  const r = runner(defs)
  const { id } = await enqueueJob(db as never, defs, 'greet', { name: 'pg' })
  await r.tick()
  expect(seen).toEqual([{ name: 'pg' }])
  const rows = await (db as unknown as PgDatabase<never>)
    .select()
    .from(bunderstackJobsPg)
    .where(eq(bunderstackJobsPg.id, id))
  expect(rows[0]?.status).toBe('succeeded')
  expect(rows[0]?.attempts).toBe(1)
})

test('pg: dedupe key collapses duplicate enqueues', async () => {
  const defs: JobsDefs = { ok: { handler: async () => {} } }
  const a = await enqueueJob(db as never, defs, 'ok', undefined, {
    dedupeKey: 'pg-once',
  })
  const b = await enqueueJob(db as never, defs, 'ok', undefined, {
    dedupeKey: 'pg-once',
  })
  expect(b.id).toBe(a.id)
})

test('pg: failure retries then fails with onFailed', async () => {
  let failed = false
  const defs: JobsDefs = {
    flaky: {
      retries: 1,
      backoff: { baseMs: 10, factor: 1 },
      handler: async () => {
        throw new Error('pg boom')
      },
      onFailed: async () => {
        failed = true
      },
    },
  }
  const r = runner(defs)
  const t0 = Date.now()
  const { id } = await enqueueJob(db as never, defs, 'flaky', undefined)
  await r.tick(t0)
  await r.tick(t0 + 20)
  const rows = await (db as unknown as PgDatabase<never>)
    .select()
    .from(bunderstackJobsPg)
    .where(eq(bunderstackJobsPg.id, id))
  expect(rows[0]?.status).toBe('failed')
  expect(rows[0]?.lastError).toContain('pg boom')
  expect(failed).toBe(true)
})
