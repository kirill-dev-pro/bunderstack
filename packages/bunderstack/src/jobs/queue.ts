// src/jobs/queue.ts — durable enqueue with constraint-backed dedupe.
import { and, eq } from 'drizzle-orm'

import type { AnyDb } from '../dialect'
import type { EnqueueOptions, JobsDefs } from './define'

import { jobsTableFor } from '../internal-tables'
import { validateStandardSchema } from '../standard-schema'
import { generate } from '../typeid'
import { CRON_PREFIX } from './slots'

export async function enqueueJob(
  db: AnyDb,
  defs: JobsDefs,
  name: string,
  input: unknown,
  opts: EnqueueOptions = {},
  now: number = Date.now(),
): Promise<{ id: string }> {
  const def = defs[name]
  if (!def) {
    throw new Error(`[bunderstack] unknown background task "${name}"`)
  }
  const isCron = def.kind === 'cron'
  const type = isCron ? `${CRON_PREFIX}${name}` : name
  // Cron slots carry no payload; queue jobs validate theirs at the call site.
  const parsed = isCron
    ? null
    : def.input
      ? validateStandardSchema(def.input, input, `job "${name}" input`)
      : null
  const t = jobsTableFor(db)
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
        type,
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
      .where(and(eq(t.type, type), eq(t.dedupeKey, opts.dedupeKey ?? '')))
      .limit(1)
    if (existing[0]) return { id: String(existing[0].id) }
  }
  throw new Error(
    `[bunderstack] enqueue of "${name}" lost a dedupe race twice — please retry`,
  )
}
