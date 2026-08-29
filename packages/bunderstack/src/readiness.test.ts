import { expect, test } from 'bun:test'

import { buildReadinessReport, isMissingRelationError } from './readiness'

const healthy = {
  queueJobsDeclared: true,
  probeDatabase: async () => {},
  countOverdueJobs: async () => 0,
}

// This one compares the whole report on purpose: it is the shape every other
// test relies on. The rest assert only the check they are about, so adding a
// new check breaks this test alone and does so deliberately.
test('a healthy application reports ok with every check green', async () => {
  expect(
    await buildReadinessReport({ ...healthy, revision: 'abc123' }),
  ).toEqual({
    status: 'ok',
    revision: 'abc123',
    checks: [
      { name: 'database', status: 'ok' },
      { name: 'schema', status: 'ok' },
      { name: 'background', status: 'ok' },
    ],
  })
})

test('an unreachable database is an error and skips the later checks', async () => {
  const report = await buildReadinessReport({
    ...healthy,
    probeDatabase: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.4:5432')
    },
  })

  expect(report.status).toBe('error')
  expect(report.checks).toContainEqual({
    name: 'database',
    status: 'error',
    code: 'unreachable',
  })
  expect(report.checks).toContainEqual({ name: 'schema', status: 'skipped' })
  expect(report.checks).toContainEqual({
    name: 'background',
    status: 'skipped',
  })
})

test('a missing internal table means the schema was never provisioned', async () => {
  const report = await buildReadinessReport({
    ...healthy,
    probeDatabase: async () => {
      throw new Error('SQLITE_ERROR: no such table: _bunderstack_jobs')
    },
  })

  expect(report.status).toBe('error')
  expect(report.checks).toContainEqual({ name: 'database', status: 'ok' })
  expect(report.checks).toContainEqual({
    name: 'schema',
    status: 'error',
    code: 'not_provisioned',
  })
  expect(report.checks).toContainEqual({
    name: 'background',
    status: 'skipped',
  })
})

test('an overdue queue backlog degrades without failing the deployment', async () => {
  const report = await buildReadinessReport({
    ...healthy,
    countOverdueJobs: async () => 12,
  })

  expect(report.status).toBe('degraded')
  expect(report.checks).toContainEqual({
    name: 'background',
    status: 'degraded',
    code: 'backlog',
    overdue: 12,
  })
})

test('an application without queue jobs skips the background check', async () => {
  const report = await buildReadinessReport({
    ...healthy,
    queueJobsDeclared: false,
  })

  expect(report.status).toBe('ok')
  expect(report.checks).toContainEqual({
    name: 'background',
    status: 'skipped',
  })
})

test('the report never carries a driver message', async () => {
  const report = await buildReadinessReport({
    ...healthy,
    probeDatabase: async () => {
      throw new Error('postgres://user:hunter2@db.internal:5432 refused')
    },
  })

  expect(JSON.stringify(report)).not.toContain('hunter2')
  expect(JSON.stringify(report)).not.toContain('db.internal')
})

test('missing-relation errors are recognised in both dialects', () => {
  expect(
    isMissingRelationError(new Error('no such table: _bunderstack_jobs')),
  ).toBe(true)
  expect(
    isMissingRelationError(
      new Error('relation "_bunderstack_jobs" does not exist'),
    ),
  ).toBe(true)
  expect(isMissingRelationError(new Error('connection refused'))).toBe(false)
})

test('a driver error wrapped by drizzle is still a missing relation', () => {
  expect(
    isMissingRelationError(
      new Error('Failed query: select "id" from "_bunderstack_jobs" limit ?', {
        cause: new Error('SQLITE_ERROR: no such table: _bunderstack_jobs'),
      }),
    ),
  ).toBe(true)
  expect(
    isMissingRelationError(
      new Error('Failed query: select "id" from "_bunderstack_jobs" limit ?', {
        cause: new Error('connect ECONNREFUSED 10.0.0.4:5432'),
      }),
    ),
  ).toBe(false)
})
