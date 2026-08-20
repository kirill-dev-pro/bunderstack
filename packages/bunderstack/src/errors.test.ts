import {
  COMMON_ERROR_STATUS_MAP,
  createProcedureClient,
  ORPCError,
} from '@orpc/server'
import { expect, test } from 'bun:test'
import * as v from 'valibot'

import { createApiBuilder } from './api/builder'
import { BunderstackError, type BunderstackErrorCode } from './errors'
import { validateStandardSchema } from './standard-schema'

const CASES = [
  ['BAD_REQUEST', 400],
  ['UNAUTHORIZED', 401],
  ['FORBIDDEN', 403],
  ['NOT_FOUND', 404],
  ['CONFLICT', 409],
  ['PAYLOAD_TOO_LARGE', 413],
  ['TOO_MANY_REQUESTS', 429],
] as const satisfies readonly (readonly [BunderstackErrorCode, number])[]

for (const [code, status] of CASES) {
  test(`maps ${code} to a typed oRPC error and HTTP ${status}`, async () => {
    const procedure = createApiBuilder().public.handler(() => {
      throw new BunderstackError(code, `${code} message`, {
        field: 'example',
      })
    })
    const client = createProcedureClient(procedure, { context: {} as never })

    const error = await client().catch((value) => value)
    expect(error).toBeInstanceOf(ORPCError)
    expect(error.code).toBe(code)
    expect(error.message).toBe(`${code} message`)
    expect(error.data).toEqual({ code, details: { field: 'example' } })
    expect(COMMON_ERROR_STATUS_MAP[code]).toBe(status)
  })
}

test('omits details when an internal error has none', async () => {
  const procedure = createApiBuilder().public.handler(() => {
    throw new BunderstackError('NOT_FOUND', 'Missing')
  })
  const client = createProcedureClient(procedure, { context: {} as never })

  const error = await client().catch((value) => value)
  expect(error.data).toEqual({ code: 'NOT_FOUND' })
})

test('maps Standard Schema failures to BAD_REQUEST', async () => {
  const procedure = createApiBuilder().public.handler(() => {
    validateStandardSchema(v.string(), 42, 'input')
  })
  const client = createProcedureClient(procedure, { context: {} as never })

  const error = await client().catch((value) => value)
  expect(error.code).toBe('BAD_REQUEST')
  expect(error.data.code).toBe('BAD_REQUEST')
  expect(error.data.details).toEqual([
    {
      path: [],
      message: 'Invalid type: Expected string but received 42',
    },
  ])
})

test('does not expose unknown exceptions as declared errors', async () => {
  const procedure = createApiBuilder().public.handler(() => {
    throw new Error('secret failure')
  })
  const client = createProcedureClient(procedure, { context: {} as never })

  const error = await client().catch((value) => value)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(BunderstackError)
  expect(error).not.toBeInstanceOf(ORPCError)
})

test('an unhandled procedure error is logged with its path before rethrowing', async () => {
  const procedure = createApiBuilder().public.handler(() => {
    throw new Error('boom')
  })
  const client = createProcedureClient(procedure, { context: {} as never })

  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => logged.push(args)
  let thrown: unknown
  try {
    thrown = await client().catch((value) => value)
  } finally {
    console.error = original
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(logged).toHaveLength(1)
  expect(String(logged[0]![0])).toContain(
    '[bunderstack-api] Unhandled error in procedure',
  )
})
