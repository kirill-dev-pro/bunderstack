// src/readiness-probes.ts — the internal jobs table doubles as the liveness
// query: reaching it proves the connection, and a missing-relation error proves
// the schema was never provisioned.
import { and, count, eq, lt } from 'drizzle-orm'

import type { AnyDb } from './dialect'
import type { ReadinessProbes } from './readiness'

import { jobsTableFor } from './internal-tables'

/** A pending job this far past its `runAt` means nothing is draining the queue. */
const OVERDUE_MS = 60_000

export function createReadinessProbes(
  db: AnyDb,
  now: () => number = Date.now,
): Pick<ReadinessProbes, 'probeDatabase' | 'countOverdueJobs'> {
  const t = jobsTableFor(db)

  return {
    probeDatabase: async () => {
      await db.select({ id: t.id }).from(t).limit(1)
    },
    countOverdueJobs: async () => {
      const rows = await db
        .select({ overdue: count() })
        .from(t)
        .where(and(eq(t.status, 'pending'), lt(t.runAt, now() - OVERDUE_MS)))
      return Number(rows[0]?.overdue ?? 0)
    },
  }
}
