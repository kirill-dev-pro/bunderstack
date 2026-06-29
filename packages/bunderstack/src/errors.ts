import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

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

export type ApiErrorBody = {
  error: string
  code?: ErrorCodeValue
  details?: unknown
}

export function apiError(
  c: Context,
  code: ErrorCodeValue,
  message: string,
  status: ContentfulStatusCode,
  details?: unknown,
) {
  const body: ApiErrorBody = {
    error: message,
    code,
    ...(details ? { details } : {}),
  }
  return c.json(body, status)
}

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
