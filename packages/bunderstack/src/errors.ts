import { ORPCError, os, type ErrorMap } from '@orpc/server'
import * as v from 'valibot'

import { StandardSchemaValidationError } from './standard-schema'

export const BUNDERSTACK_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
] as const

export type BunderstackErrorCode = (typeof BUNDERSTACK_ERROR_CODES)[number]

export const BUNDERSTACK_ERROR_STATUS_MAP = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
} as const satisfies Record<BunderstackErrorCode, number>

function errorDataSchema<const TCode extends BunderstackErrorCode>(
  code: TCode,
) {
  return v.strictObject({
    code: v.literal(code),
    details: v.optional(v.unknown()),
  })
}

export const BUNDERSTACK_ERRORS = {
  VALIDATION_ERROR: { data: errorDataSchema('VALIDATION_ERROR') },
  UNAUTHORIZED: { data: errorDataSchema('UNAUTHORIZED') },
  FORBIDDEN: { data: errorDataSchema('FORBIDDEN') },
  NOT_FOUND: { data: errorDataSchema('NOT_FOUND') },
  CONFLICT: { data: errorDataSchema('CONFLICT') },
  PAYLOAD_TOO_LARGE: { data: errorDataSchema('PAYLOAD_TOO_LARGE') },
  RATE_LIMITED: { data: errorDataSchema('RATE_LIMITED') },
} as const satisfies ErrorMap

export class BunderstackError extends Error {
  readonly status: number

  constructor(
    readonly code: BunderstackErrorCode,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BunderstackError'
    this.status = BUNDERSTACK_ERROR_STATUS_MAP[code]
  }
}

export const mapBunderstackErrors = os
  .errors(BUNDERSTACK_ERRORS)
  .middleware(async ({ next }) => {
    try {
      return await next()
    } catch (error) {
      const mapped =
        error instanceof StandardSchemaValidationError
          ? new BunderstackError(
              'VALIDATION_ERROR',
              error.message,
              error.issues,
              { cause: error },
            )
          : error
      if (!(mapped instanceof BunderstackError)) throw error

      throw new ORPCError(mapped.code, {
        message: mapped.message,
        data:
          mapped.details === undefined
            ? { code: mapped.code }
            : { code: mapped.code, details: mapped.details },
        cause: mapped,
      })
    }
  })

/** @deprecated Legacy internal error codes retained for list-query compatibility. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_CURSOR: 'INVALID_CURSOR',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_REPLAY: 'IDEMPOTENCY_REPLAY',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export class ListQueryError extends Error {
  readonly code: ErrorCodeValue
  readonly details?: unknown

  constructor(
    message: string,
    code: ErrorCodeValue = ErrorCode.VALIDATION_ERROR,
    details?: unknown,
  ) {
    super(message)
    this.name = 'ListQueryError'
    this.code = code
    this.details = details
  }
}
