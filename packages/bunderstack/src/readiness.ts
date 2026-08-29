// src/readiness.ts — machine-readable "did this release come up" report.
// Public endpoint: results carry a closed set of codes and never a driver
// message, a connection string, or a stack trace.
import * as v from 'valibot'

export type ReadinessStatus = 'ok' | 'degraded' | 'error' | 'skipped'
export type ReadinessCode = 'unreachable' | 'not_provisioned' | 'backlog'
export type ReadinessCheckName = 'database' | 'schema' | 'background'

export type ReadinessCheck = {
  name: ReadinessCheckName
  status: ReadinessStatus
  code?: ReadinessCode
  overdue?: number
}

export type ReadinessReport = {
  status: 'ok' | 'degraded' | 'error'
  revision?: string
  checks: ReadinessCheck[]
}

export type ReadinessProbes = {
  /** Deployed commit, when the platform injects `BUNDERSTACK_REVISION`. */
  revision?: string
  queueJobsDeclared: boolean
  probeDatabase: () => Promise<void>
  countOverdueJobs: () => Promise<number>
}

export const readinessReportSchema = v.strictObject({
  status: v.picklist(['ok', 'degraded', 'error']),
  revision: v.optional(v.string()),
  checks: v.array(
    v.strictObject({
      name: v.picklist(['database', 'schema', 'background']),
      status: v.picklist(['ok', 'degraded', 'error', 'skipped']),
      code: v.optional(
        v.picklist(['unreachable', 'not_provisioned', 'backlog']),
      ),
      overdue: v.optional(v.number()),
    }),
  ),
})

const MISSING_RELATION =
  /no such table|does not exist|undefined table|unknown table/i

/**
 * A query that fails this way reached the database and found no schema.
 * Drizzle wraps the driver error, so the relation name lives on `cause`.
 */
export function isMissingRelationError(error: unknown): boolean {
  let current: unknown = error
  for (
    let depth = 0;
    current !== undefined && current !== null && depth < 8;
    depth += 1
  ) {
    const message = current instanceof Error ? current.message : String(current)
    if (MISSING_RELATION.test(message)) return true
    if (!(current instanceof Error)) return false
    current = current.cause
  }
  return false
}

export async function buildReadinessReport(
  probes: ReadinessProbes,
): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = []
  let queryable = false

  try {
    await probes.probeDatabase()
    checks.push(
      { name: 'database', status: 'ok' },
      { name: 'schema', status: 'ok' },
    )
    queryable = true
  } catch (error) {
    checks.push(
      isMissingRelationError(error)
        ? { name: 'database', status: 'ok' }
        : { name: 'database', status: 'error', code: 'unreachable' },
      isMissingRelationError(error)
        ? { name: 'schema', status: 'error', code: 'not_provisioned' }
        : { name: 'schema', status: 'skipped' },
    )
  }

  if (!queryable || !probes.queueJobsDeclared) {
    checks.push({ name: 'background', status: 'skipped' })
  } else {
    try {
      const overdue = await probes.countOverdueJobs()
      checks.push(
        overdue > 0
          ? { name: 'background', status: 'degraded', code: 'backlog', overdue }
          : { name: 'background', status: 'ok' },
      )
    } catch {
      checks.push({ name: 'background', status: 'skipped' })
    }
  }

  const status = checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ok'

  return {
    status,
    ...(probes.revision === undefined ? {} : { revision: probes.revision }),
    checks,
  }
}
