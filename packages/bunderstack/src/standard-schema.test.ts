import type { StandardSchemaV1 } from '@standard-schema/spec'

import { expect, test } from 'bun:test'
import * as v from 'valibot'

import {
  StandardSchemaValidationError,
  validateStandardSchema,
} from './standard-schema'

test('validates a Valibot schema synchronously', () => {
  const schema = v.object({ name: v.string() })

  expect(validateStandardSchema(schema, { name: 'Kirill' }, 'profile')).toEqual(
    {
      name: 'Kirill',
    },
  )
})

test('returns the transformed schema output', () => {
  const schema = v.pipe(
    v.string(),
    v.transform((value) => value.length),
  )

  const length: number = validateStandardSchema(schema, 'bunderstack', 'name')
  expect(length).toBe(11)
})

test('normalizes validation issue paths and messages', () => {
  const schema = v.object({ profile: v.object({ name: v.string() }) })

  try {
    validateStandardSchema(schema, { profile: { name: 42 } }, 'input')
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(StandardSchemaValidationError)
    expect((error as StandardSchemaValidationError).issues).toEqual([
      {
        path: ['profile', 'name'],
        message: 'Invalid type: Expected string but received 42',
      },
    ])
    expect((error as Error).message).toContain(
      'input.profile.name: Invalid type: Expected string but received 42',
    )
  }
})

test('rejects asynchronous validation at synchronous boundaries', () => {
  const asyncSchema: StandardSchemaV1<unknown, unknown> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async (value) => ({ value }),
    },
  }

  expect(() => validateStandardSchema(asyncSchema, 'value', 'env')).toThrow(
    '[bunderstack] env schema validation must be synchronous',
  )
})
