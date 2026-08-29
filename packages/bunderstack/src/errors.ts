import {
  COMMON_ERROR_STATUS_MAP,
  ORPCError,
  os,
  type ErrorMap,
} from '@orpc/server'
import * as v from 'valibot'

import type { BunderstackLogger } from './logging'

import { consoleLogger } from './logging'
import { StandardSchemaValidationError } from './standard-schema'

/**
 * Every code we raise is one oRPC already knows, so handlers derive the HTTP
 * status from `COMMON_ERROR_STATUS_MAP` on their own and clients can use the
 * standard `isDefinedError` helpers. Do not add a code oRPC has no status for —
 * it would silently answer 500.
 */
export const BUNDERSTACK_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'TOO_MANY_REQUESTS',
] as const satisfies readonly (keyof typeof COMMON_ERROR_STATUS_MAP)[]

export type BunderstackErrorCode = (typeof BUNDERSTACK_ERROR_CODES)[number]

/**
 * `data` and its `code` both default, so an application raises a declared
 * error with a message alone: `errors.NOT_FOUND({ message })`. The code is
 * already the name of the constructor, and repeating it at every call site is
 * the reason applications fall back to a raw `ORPCError`. Clients still read a
 * populated `data.code`, because the default fills it.
 */
function errorDataSchema<const TCode extends BunderstackErrorCode>(
  code: TCode,
) {
  return v.optional(
    v.strictObject({
      code: v.optional(v.literal(code), code),
      details: v.optional(v.unknown()),
    }),
    { code },
  )
}

export const BUNDERSTACK_ERRORS = {
  BAD_REQUEST: { data: errorDataSchema('BAD_REQUEST') },
  UNAUTHORIZED: { data: errorDataSchema('UNAUTHORIZED') },
  FORBIDDEN: { data: errorDataSchema('FORBIDDEN') },
  NOT_FOUND: { data: errorDataSchema('NOT_FOUND') },
  CONFLICT: { data: errorDataSchema('CONFLICT') },
  PAYLOAD_TOO_LARGE: { data: errorDataSchema('PAYLOAD_TOO_LARGE') },
  TOO_MANY_REQUESTS: { data: errorDataSchema('TOO_MANY_REQUESTS') },
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
    this.status = COMMON_ERROR_STATUS_MAP[code]
  }
}

export const mapBunderstackErrors = os
  .errors(BUNDERSTACK_ERRORS)
  .middleware(async ({ next, path, context }) => {
    try {
      return await next()
    } catch (error) {
      const mapped =
        error instanceof StandardSchemaValidationError
          ? new BunderstackError('BAD_REQUEST', error.message, error.issues, {
              cause: error,
            })
          : error
      if (!(mapped instanceof BunderstackError)) {
        const procName = path?.length ? path.join('.') : 'unknown'
        const logger =
          (context as { logger?: BunderstackLogger }).logger ?? consoleLogger
        logger.error(
          `[bunderstack-api] Unhandled error in procedure "${procName}":`,
          error,
        )
        throw error
      }

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

/**
 * Sub-codes carried in `data.details.code` when the oRPC code alone loses
 * information the client may want to branch on. Codes that duplicate an oRPC
 * code are suppressed as redundant, see {@link CrudOperationError}.
 */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_CURSOR: 'INVALID_CURSOR',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  IDEMPOTENCY_REPLAY: 'IDEMPOTENCY_REPLAY',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export class ListQueryError extends Error {
  readonly code: ErrorCodeValue
  readonly details?: unknown

  constructor(
    message: string,
    code: ErrorCodeValue = ErrorCode.BAD_REQUEST,
    details?: unknown,
  ) {
    super(message)
    this.name = 'ListQueryError'
    this.code = code
    this.details = details
  }
}
