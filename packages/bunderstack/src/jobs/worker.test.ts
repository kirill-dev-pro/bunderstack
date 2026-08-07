import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { test, expect, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { JobsDefs } from './define'

import { libsql } from '../database/libsql'
import { createDb } from '../db'
import { bunderstackJobs, withInternalTables } from '../internal-tables'
import { provisionSchema } from '../provision'
import { enqueueJob } from './queue'
import { createJobRunner } from './worker'

let db: LibSQLDatabase<Record<string, never>>

async function freshDb() {
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
      kind: 'job',
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
      kind: 'job',
      handler: async (_input, ctx) => {
        ran.push('first')
        await ctx.jobs.enqueue('second')
      },
    },
    second: {
      kind: 'job',
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
      kind: 'job',
      retries: 2,
      backoff: (attempt) => 1000 * 2 ** (attempt - 1),
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

test('jobs clear dedupeKey on terminal status; re-enqueue works', async () => {
  const defs: JobsDefs = { ok: { kind: 'job', handler: async () => {} } }
  const r = runner(defs)
  const a = await enqueueJob(db, defs, 'ok', undefined, { dedupeKey: 'd' })
  await r.tick()
  expect((await rowById(a.id))?.dedupeKey).toBeNull()
  const b = await enqueueJob(db, defs, 'ok', undefined, { dedupeKey: 'd' })
  expect(b.id).not.toBe(a.id)
})

test('expired lease recovers to pending and burns the attempt', async () => {
  const defs: JobsDefs = {
    stuck: {
      kind: 'job',
      retries: 3,
      timeout: 60_000,
      backoff: () => 1000,
      handler: async () => {},
    },
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
      kind: 'job',
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
      kind: 'job',
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
      kind: 'job',
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

import { and, eq as eqOp } from 'drizzle-orm'

import { CRON_PREFIX, SLOT_MS } from './slots'

async function cronRows(name: string) {
  return db
    .select()
    .from(bunderstackJobs)
    .where(eqOp(bunderstackJobs.type, `${CRON_PREFIX}${name}`))
}

test('tick materializes the current slot on first sight', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const now = Date.parse('2026-08-07T10:00:30Z')
  await runner(defs).tick(now)

  const rows = await cronRows('beat')
  expect(rows).toHaveLength(1)
  expect(Number(rows[0]!.runAt)).toBe(Date.parse('2026-08-07T10:00:00Z'))
  expect(rows[0]!.status).toBe('succeeded')
})

test('a completed cron slot is not re-materialized on a later tick in the same minute', async () => {
  let runs = 0
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: () => {
        runs++
      },
    },
  }
  const r = runner(defs)
  const t0 = Date.parse('2026-08-07T10:00:10Z')
  await r.tick(t0)
  expect(runs).toBe(1)
  const rows1 = await cronRows('beat')
  expect(rows1[0]!.status).toBe('succeeded')
  expect(rows1[0]!.dedupeKey).toBeNull()

  await r.tick(t0 + 30_000)
  const rows2 = await cronRows('beat')
  expect(rows2).toHaveLength(1)
  expect(runs).toBe(1)
})

test('tick does not backfill from epoch on first sight', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', catchUp: 'all', handler: () => {} },
  }
  await runner(defs).tick(Date.parse('2026-08-07T10:00:30Z'))
  expect(await cronRows('beat')).toHaveLength(1)
})

test('materialization is idempotent across concurrent ticks', async () => {
  let runs = 0
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: () => {
        runs++
      },
    },
  }
  const now = Date.parse('2026-08-07T10:00:30Z')
  const a = runner(defs)
  const b = runner(defs)
  await Promise.all([a.tick(now), b.tick(now)])

  expect(await cronRows('beat')).toHaveLength(1)
  expect(runs).toBe(1)
})

test('the watermark advances so a slot is materialized once per minute', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const r = runner(defs)
  const t0 = Date.parse('2026-08-07T10:00:30Z')
  await r.tick(t0)
  await r.tick(t0 + 10_000)
  await r.tick(t0 + SLOT_MS)

  const runAts = (await cronRows('beat')).map((row) => Number(row.runAt)).sort()
  expect(runAts).toEqual([
    Date.parse('2026-08-07T10:00:00Z'),
    Date.parse('2026-08-07T10:01:00Z'),
  ])
})

test('a non-matching minute materializes nothing', async () => {
  const defs: JobsDefs = {
    hourly: { kind: 'cron', schedule: '0 * * * *', handler: () => {} },
  }
  await runner(defs).tick(Date.parse('2026-08-07T10:30:00Z'))
  expect(await cronRows('hourly')).toHaveLength(0)
})

test('succeeded rows are reaped after the retention window', async () => {
  const defs: JobsDefs = { ok: { kind: 'job', handler: async () => {} } }
  const r = runner(defs)
  const t0 = Date.now()
  await enqueueJob(db, defs, 'ok', undefined)
  await r.tick(t0)
  await r.tick(t0 + 25 * 60 * 60 * 1000) // > 24h later
  const rows = await db.select().from(bunderstackJobs)
  // The succeeded row is gone (only rows from this test's runs remain pending-free).
  expect(rows.filter((x) => x.status === 'succeeded')).toHaveLength(0)
})

test('a cron handler receives its scheduled slot', async () => {
  const seen: Date[] = []
  const defs: JobsDefs = {
    beat: {
      kind: 'cron',
      schedule: '* * * * *',
      handler: (invocation) => {
        seen.push(invocation.scheduledFor)
      },
    },
  }
  await runner(defs).tick(Date.parse('2026-08-07T10:00:30Z'))
  expect(seen).toHaveLength(1)
  expect(seen[0]!.toISOString()).toBe('2026-08-07T10:00:00.000Z')
})

test('a failing cron slot retries with backoff then fires onFailed', async () => {
  let attempts = 0
  const failures: string[] = []
  const defs: JobsDefs = {
    flaky: {
      kind: 'cron',
      schedule: '* * * * *',
      retries: 1,
      backoff: () => 0,
      handler: () => {
        attempts++
        throw new Error('boom')
      },
      onFailed: (_invocation, error) => {
        failures.push(error.message)
      },
    },
  }
  const r = runner(defs)
  const now = Date.parse('2026-08-07T10:00:30Z')
  await r.tick(now)
  expect(attempts).toBe(1)
  expect(failures).toEqual([])

  await r.tick(now + 1_000)
  expect(attempts).toBe(2)
  expect(failures).toEqual(['boom'])

  const rows = await cronRows('flaky')
  expect(rows[0]!.status).toBe('failed')
  expect(rows[0]!.dedupeKey).toBeNull()
})

test('a cron slot whose type has no definition is failed, not retried forever', async () => {
  const defs: JobsDefs = {
    beat: { kind: 'cron', schedule: '* * * * *', handler: () => {} },
  }
  const r = runner(defs)
  await r.tick(Date.parse('2026-08-07T10:00:30Z'))
  const r2 = runner({})
  await r2.tick(Date.parse('2026-08-07T10:01:30Z'))
  const rows = await cronRows('beat')
  expect(rows[0]!.status).toBe('succeeded')
})

test('a worker that lost its lease cannot mark a re-claimed row succeeded', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let startedResolve: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve
  })
  const defs: JobsDefs = {
    slow: {
      kind: 'job',
      timeout: 10,
      handler: async () => {
        startedResolve?.()
        await gate
      },
    },
  }
  const { id } = await enqueueJob(db, defs, 'slow', undefined)

  const first = runner(defs)
  const now = Date.now()
  const running = first.tick(now)

  await started

  // Steal the lease the way lease recovery would after the timeout elapses.
  await db
    .update(bunderstackJobs)
    .set({ status: 'running', lockedUntil: now + 100_000, attempts: 2 })
    .where(eq(bunderstackJobs.id, id))

  release!()
  await running

  const row = await rowById(id)
  expect(row!.status).toBe('running')
  expect(Number(row!.lockedUntil)).toBe(now + 100_000)
})

test('tick reports what it did', async () => {
  const defs: JobsDefs = {
    ok: { kind: 'job', handler: () => {} },
    bad: {
      kind: 'job',
      retries: 0,
      handler: () => {
        throw new Error('nope')
      },
    },
  }
  await enqueueJob(db, defs, 'ok', undefined)
  await enqueueJob(db, defs, 'bad', undefined)

  const result = await runner(defs).tick(Date.now())
  expect(result.claimed).toBe(2)
  expect(result.ran).toBe(1)
  expect(result.failed).toBe(1)
})

test('the reap runs at most hourly', async () => {
  const defs: JobsDefs = { ok: { kind: 'job', handler: () => {} } }
  const r = runner(defs)
  const now = Date.parse('2026-08-07T10:00:00Z')
  await r.tick(now)

  const stale = Date.parse('2026-08-05T10:00:00Z')
  await enqueueJob(db, defs, 'ok', undefined, { dedupeKey: 'old' })
  await db
    .update(bunderstackJobs)
    .set({ status: 'succeeded', finishedAt: stale, dedupeKey: null })
    .where(eq(bunderstackJobs.type, 'ok'))

  // Within the hour: no reap.
  await r.tick(now + 60_000)
  expect(await db.select().from(bunderstackJobs)).not.toHaveLength(0)

  // Past the hour: reaped.
  await r.tick(now + 3_600_001)
  const remaining = await db.select().from(bunderstackJobs)
  expect(remaining.filter((row) => row.status === 'succeeded')).toHaveLength(0)
})




