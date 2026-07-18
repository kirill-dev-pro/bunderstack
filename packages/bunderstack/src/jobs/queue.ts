// src/jobs/queue.ts — durable enqueue with constraint-backed dedupe.
import { and, eq } from 'drizzle-orm'

import type { AnyDb } from '../dialect'
import type { EnqueueOptions, JobsDefs } from './define'

import { jobsTableFor } from '../internal-tables'
import { generate } from '../typeid'

export async function enqueueJob(
  db: AnyDb,
  defs: JobsDefs,
  name: string,
  input: unknown,
  opts: EnqueueOptions = {},
): Promise<{ id: string }> {
  const def = defs[name]
  if (!def || def.kind !== 'job') {
    throw new Error(`[bunderstack] unknown queue job "${name}"`)
  }
  // Fail fast: a bad payload should throw at the call site, not in the worker.
  const parsed = def.input ? def.input.parse(input) : null
  const t = jobsTableFor(db)
  const now = Date.now()
  const runAt =
    opts.runAt !== undefined
      ? new Date(opts.runAt).getTime()
      : now + (opts.delay ?? 0)

  // Two rounds cover the race where the deduping row reaches a terminal state
  // (clearing its key) between our failed insert and our read.
  for (let round = 0; round < 2; round++) {
    const id = generate('job')
    const insertedRows = await db
      .insert(t)
      .values({
        id,
        type: name,
        payloadJson: JSON.stringify(parsed),
        status: 'pending',
        attempts: 0,
        runAt,
        dedupeKey: opts.dedupeKey ?? null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [t.type, t.dedupeKey] })
      .returning({ id: t.id })
    if (insertedRows[0]) return { id: String(insertedRows[0].id) }
    const existing = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.type, name), eq(t.dedupeKey, opts.dedupeKey ?? '')))
      .limit(1)
    if (existing[0]) return { id: String(existing[0].id) }
  }
  throw new Error(
    `[bunderstack] enqueue of "${name}" lost a dedupe race twice — please retry`,
  )
}
