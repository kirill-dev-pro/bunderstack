import { expect, test } from 'bun:test'

import { isLostConnectionError } from './lost-connection'

const failedQuery = (cause?: unknown) =>
  Object.assign(new Error('Failed query: insert into "jobs" … params: …'), {
    cause,
  })

test('a reset socket behind a failed query is a lost connection', () => {
  expect(
    isLostConnectionError(
      failedQuery(
        new TypeError(
          'ECONNRESET: The socket connection was closed unexpectedly.',
        ),
      ),
    ),
  ).toBe(true)
  expect(
    isLostConnectionError(
      failedQuery(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })),
    ),
  ).toBe(true)
})

test('a gateway status from the edge is a lost connection', () => {
  expect(
    isLostConnectionError(
      failedQuery(
        Object.assign(new Error('Server returned HTTP status 502'), {
          status: 502,
        }),
      ),
    ),
  ).toBe(true)
})

test('what the database itself refused is not', () => {
  expect(
    isLostConnectionError(
      failedQuery(
        new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: jobs.id'),
      ),
    ),
  ).toBe(false)
  expect(isLostConnectionError(undefined)).toBe(false)
  expect(isLostConnectionError('ECONNRESET')).toBe(false)
})

test('text quoted from the statement does not count', () => {
  expect(
    isLostConnectionError(
      new Error(
        'Failed query: insert into "log" values (?) params: ECONNRESET',
      ),
    ),
  ).toBe(false)
})
