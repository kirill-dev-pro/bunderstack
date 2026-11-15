import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { test, expect, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import * as v from 'valibot'

import type { JobsDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackJobs, withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision-schema'
import { enqueueJob } from './queue'

let db: LibSQLDatabase<Record<string, never>>

const defs: JobsDefs = {
  greet: {
    kind: 'job',
    input: v.object({ name: v.string() }),
    handler: async () => {},
  },
  bare: { kind: 'job', handler: async () => {} },
}

beforeAll(async () => {
  ;({ db } = await createDb(
    {},
    { url: ':memory:', dialect: 'sqlite', adapter: libsql() },
  ))
  const merged = withInternalTables({})
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
})

test('enqueue inserts a pending row with parsed payload', async () => {
  const { id } = await enqueueJob(db, defs, 'greet', { name: 'kirill' })
  expect(id.startsWith('job_')).toBe(true)
  const rows = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id))
  expect(rows[0]?.status).toBe('pending')
  expect(rows[0]?.type).toBe('greet')
  expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ name: 'kirill' })
  expect(rows[0]!.runAt).toBeLessThanOrEqual(Date.now())
  expect(rows[0]!.attempts).toBe(0)
})

test('unknown queue job name throws', async () => {
  await expect(enqueueJob(db, defs, 'nope', {})).rejects.toThrow(
    /unknown background task/,
  )
})

test('cron declarations can be enqueued', async () => {
  const cronDefs: JobsDefs = {
    hourly: {
      kind: 'cron',
      schedule: '0 * * * *',
      handler: async () => {},
    },
  }
  const { id } = await enqueueJob(db, cronDefs, 'hourly', undefined, {
    dedupeKey: '12345',
  })
  expect(id.startsWith('job_')).toBe(true)
  const rows = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id))
  expect(rows[0]?.type).toBe('cron:hourly')
})

test('payload failing schema validation throws at the enqueue site', async () => {
  await expect(enqueueJob(db, defs, 'greet', { name: 42 })).rejects.toThrow()
})

test('delay and runAt land in run_at', async () => {
  const before = Date.now()
  const { id } = await enqueueJob(db, defs, 'bare', undefined, {
    delay: 60_000,
  })
  const [row] = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id))
  expect(row!.runAt).toBeGreaterThanOrEqual(before + 60_000)

  const at = Date.now() + 120_000
  const { id: id2 } = await enqueueJob(db, defs, 'bare', undefined, {
    runAt: new Date(at),
  })
  const [row2] = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id2))
  expect(row2!.runAt).toBe(at)
})

test('duplicate dedupeKey is a no-op returning the existing id', async () => {
  const a = await enqueueJob(db, defs, 'bare', undefined, { dedupeKey: 'once' })
  const b = await enqueueJob(db, defs, 'bare', undefined, { dedupeKey: 'once' })
  expect(b.id).toBe(a.id)
  const rows = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.dedupeKey, 'once'))
  expect(rows).toHaveLength(1)
})

test('same dedupeKey on a different type is a distinct job', async () => {
  const a = await enqueueJob(db, defs, 'bare', undefined, { dedupeKey: 'k' })
  const b = await enqueueJob(
    db,
    defs,
    'greet',
    { name: 'x' },
    { dedupeKey: 'k' },
  )
  expect(b.id).not.toBe(a.id)
})

function lostConnection(): Error {
  return Object.assign(
    new Error('Failed query: insert into "_bunderstack_jobs" … params: …'),
    {
      cause: Object.assign(
        new TypeError(
          'ECONNRESET: The socket connection was closed unexpectedly.',
        ),
        { code: 'ECONNRESET' },
      ),
    },
  )
}

/** The app database, except that its first insert loses the connection:
 *  after the row is written when `landed`, before it is when not. */
function losingFirstInsert(
  target: LibSQLDatabase<Record<string, never>>,
  landed: boolean,
): LibSQLDatabase<Record<string, never>> {
  let armed = true
  return new Proxy(target, {
    get(inner, prop, receiver) {
      if (prop !== 'insert' || !armed) return Reflect.get(inner, prop, receiver)
      return (table: never) => {
        armed = false
        const insert = inner.insert(table)
        return {
          values: (values: never) => ({
            onConflictDoNothing: (config: never) => ({
              returning: async (fields: never) => {
                if (landed)
                  await insert
                    .values(values)
                    .onConflictDoNothing(config)
                    .returning(fields)
                throw lostConnection()
              },
            }),
          }),
        }
      }
    },
  })
}

async function rowsWithKey(dedupeKey: string) {
  return db
    .select({ id: bunderstackJobs.id })
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.dedupeKey, dedupeKey))
}

test.each([
  ['after the row was written', true],
  ['before the row was written', false],
])('a deduped enqueue survives a connection lost %s', async (_when, landed) => {
  const dedupeKey = `lost-${landed}`
  const { id } = await enqueueJob(
    losingFirstInsert(db, landed),
    defs,
    'bare',
    undefined,
    { dedupeKey },
    Date.now(),
    true,
  )
  expect(await rowsWithKey(dedupeKey)).toEqual([{ id }])
})

test('an enqueue without a dedupe key does not risk a second insert', async () => {
  await expect(
    enqueueJob(
      losingFirstInsert(db, true),
      defs,
      'bare',
      undefined,
      {},
      Date.now(),
      true,
    ),
  ).rejects.toThrow(/Failed query/)
})

test('an enqueue inside a transaction lets a lost connection through', async () => {
  await expect(
    enqueueJob(
      losingFirstInsert(db, false),
      defs,
      'bare',
      undefined,
      { dedupeKey: 'lost-in-tx' },
      Date.now(),
      false,
    ),
  ).rejects.toThrow(/Failed query/)
  expect(await rowsWithKey('lost-in-tx')).toEqual([])
})
