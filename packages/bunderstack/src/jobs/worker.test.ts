import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { test, expect, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { JobsDefs } from './define'

import { createDb } from '../db'
import { bunderstackJobs, withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { enqueueJob } from './queue'
import { createJobRunner } from './worker'

let db: LibSQLDatabase<Record<string, never>>

async function freshDb() {
  ;({ db } = await createDb({}, { url: ':memory:', dialect: 'sqlite' }))
  const merged = withInternalTables({})
  await provisionSchema(
    db as unknown as LibSQLDatabase<typeof merged>,
    merged,
    { force: true },
  )
}

function runner(defs: JobsDefs) {
  const r = createJobRunner({ db, defs, ctx: {} })
  r.setJobsFacade({
    enqueue: (name, input, opts) => enqueueJob(db, defs, name, input, opts),
    tick: (now) => r.tick(now),
  })
  return r
}

async function rowById(id: string) {
  const rows = await db
    .select()
    .from(bunderstackJobs)
    .where(eq(bunderstackJobs.id, id))
  return rows[0]
}

beforeEach(freshDb)

test('tick claims and runs a pending job to succeeded', async () => {
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
  const { id } = await enqueueJob(db, defs, 'greet', { name: 'k' })
  await r.tick()
  expect(seen).toEqual([{ name: 'k' }])
  const row = await rowById(id)
  expect(row?.status).toBe('succeeded')
  expect(row?.attempts).toBe(1)
  expect(row?.finishedAt).not.toBeNull()
})

test('handler ctx includes the jobs facade (jobs can enqueue jobs)', async () => {
  const ran: string[] = []
  const defs: JobsDefs = {
    first: {
      handler: async (_input, ctx) => {
        ran.push('first')
        await ctx.jobs.enqueue('second')
      },
    },
    second: {
      handler: async () => {
        ran.push('second')
      },
    },
  }
  const r = runner(defs)
  await enqueueJob(db, defs, 'first', undefined)
  await r.tick()
  await r.tick() // second was enqueued during the first tick
  expect(ran).toEqual(['first', 'second'])
})

test('failure retries with backoff, then fails and fires onFailed', async () => {
  let calls = 0
  let failed: { error: Error } | undefined
  const defs: JobsDefs = {
    flaky: {
      retries: 2,
      backoff: { baseMs: 1000, factor: 2 },
      handler: async () => {
        calls++
        throw new Error(`boom ${calls}`)
      },
      onFailed: async (_input, error) => {
        failed = { error }
      },
    },
  }
  const r = runner(defs)
  const t0 = Date.now()
  const { id } = await enqueueJob(db, defs, 'flaky', undefined)

  await r.tick(t0) // attempt 1 fails
  let row = await rowById(id)
  expect(row?.status).toBe('pending')
  expect(row?.attempts).toBe(1)
  expect(row?.lastError).toContain('boom 1')
  expect(row?.runAt).toBeGreaterThanOrEqual(t0 + 1000)

  await r.tick(t0 + 999) // before backoff elapses: not claimed
  expect(calls).toBe(1)

  await r.tick(t0 + 1001) // attempt 2 fails
  await r.tick(t0 + 1001 + 2000) // attempt 3 (last) fails → failed
  row = await rowById(id)
  expect(calls).toBe(3) // retries: 2 → 3 total attempts
  expect(row?.status).toBe('failed')
  expect(row?.lastError).toContain('boom 3')
  expect(failed?.error.message).toContain('boom 3')
})

test('non-cron jobs clear dedupeKey on terminal status; re-enqueue works', async () => {
  const defs: JobsDefs = { ok: { handler: async () => {} } }
  const r = runner(defs)
  const a = await enqueueJob(db, defs, 'ok', undefined, { dedupeKey: 'd' })
  await r.tick()
  expect((await rowById(a.id))?.dedupeKey).toBeNull()
  const b = await enqueueJob(db, defs, 'ok', undefined, { dedupeKey: 'd' })
  expect(b.id).not.toBe(a.id)
})

test('expired lease recovers to pending and burns the attempt', async () => {
  const defs: JobsDefs = {
    stuck: { retries: 3, timeout: 60_000, handler: async () => {} },
  }
  const r = runner(defs)
  const t0 = Date.now()
  const { id } = await enqueueJob(db, defs, 'stuck', undefined)
  // Simulate a crashed worker: claimed (attempts=1) but never finished.
  await db
    .update(bunderstackJobs)
    .set({ status: 'running', attempts: 1, lockedUntil: t0 - 1 })
    .where(eq(bunderstackJobs.id, id))
  // Recovery flips it to pending with backoff (default: 1000ms for attempt 1),
  // so the SAME tick does not re-claim it — the next tick past the backoff does.
  await r.tick(t0)
  let row = await rowById(id)
  expect(row?.status).toBe('pending')
  expect(row?.attempts).toBe(1)
  expect(row?.lastError).toContain('lease expired')
  await r.tick(t0 + 1001)
  row = await rowById(id)
  expect(row?.status).toBe('succeeded')
  expect(row?.attempts).toBe(2) // 1 burned by the crash + 1 for the real run
})

test('expired lease with exhausted attempts goes to failed and fires onFailed', async () => {
  let failed = false
  const defs: JobsDefs = {
    stuck: {
      retries: 0,
      handler: async () => {},
      onFailed: async () => {
        failed = true
      },
    },
  }
  const r = runner(defs)
  const t0 = Date.now()
  const { id } = await enqueueJob(db, defs, 'stuck', undefined)
  await db
    .update(bunderstackJobs)
    .set({ status: 'running', attempts: 1, lockedUntil: t0 - 1 })
    .where(eq(bunderstackJobs.id, id))
  await r.tick(t0)
  const row = await rowById(id)
  expect(row?.status).toBe('failed')
  expect(row?.lastError).toContain('lease expired')
  expect(failed).toBe(true)
})

test('concurrency limits simultaneous claims of one type', async () => {
  let running = 0
  let maxRunning = 0
  const defs: JobsDefs = {
    limited: {
      concurrency: 1,
      handler: async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((resolve) => setTimeout(resolve, 10))
        running--
      },
    },
  }
  const r = runner(defs)
  await enqueueJob(db, defs, 'limited', undefined)
  await enqueueJob(db, defs, 'limited', undefined)
  await r.tick()
  const rows = await db.select().from(bunderstackJobs)
  // One ran, one is still pending — a single tick claims at most `concurrency`.
  expect(rows.filter((x) => x.status === 'succeeded')).toHaveLength(1)
  expect(rows.filter((x) => x.status === 'pending')).toHaveLength(1)
  await r.tick()
  expect(maxRunning).toBe(1)
})

test('malformed stored payload fails immediately without retries', async () => {
  const defs: JobsDefs = {
    typed: {
      input: z.object({ n: z.number() }),
      retries: 5,
      handler: async () => {},
    },
  }
  const r = runner(defs)
  const { id } = await enqueueJob(db, defs, 'typed', { n: 1 })
  // Simulate schema drift: stored payload no longer parses.
  await db
    .update(bunderstackJobs)
    .set({ payloadJson: JSON.stringify({ n: 'nope' }) })
    .where(eq(bunderstackJobs.id, id))
  await r.tick()
  const row = await rowById(id)
  expect(row?.status).toBe('failed')
  expect(row?.attempts).toBe(1)
})

test('cron enqueues one slot per minute, dedupe collapses repeat ticks', async () => {
  let runs = 0
  const defs: JobsDefs = {
    every: {
      cron: '* * * * *',
      handler: async () => {
        runs++
      },
    },
  }
  const r = runner(defs)
  const minute = Math.floor(Date.now() / 60_000) * 60_000
  await r.tick(minute)
  await r.tick(minute + 10_000) // same minute: dedupe, no second row
  expect(runs).toBe(1)
  const rows = await db.select().from(bunderstackJobs)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.dedupeKey).toBe(`cron:every:${minute}`)
  expect(rows[0]?.status).toBe('succeeded') // cron rows KEEP their dedupe key
  await r.tick(minute + 60_000) // next minute: new slot
  expect(runs).toBe(2)
})

test('succeeded rows are reaped after the retention window', async () => {
  const defs: JobsDefs = { ok: { handler: async () => {} } }
  const r = runner(defs)
  const t0 = Date.now()
  await enqueueJob(db, defs, 'ok', undefined)
  await r.tick(t0)
  await r.tick(t0 + 25 * 60 * 60 * 1000) // > 24h later
  const rows = await db.select().from(bunderstackJobs)
  // The succeeded row is gone (only rows from this test's runs remain pending-free).
  expect(rows.filter((x) => x.status === 'succeeded')).toHaveLength(0)
})
