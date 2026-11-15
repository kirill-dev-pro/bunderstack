/**
 * Errors that mean the database was not reached, or its answer never came
 * back: a pooled connection the far side had already closed (ECONNRESET), a
 * refused or timed-out socket, or the edge in front of a remote libSQL
 * answering 502/520 for a moment. Whether a write landed is unknown after one,
 * so only a statement that is safe to send twice may be retried on it.
 */

const LOST_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'ConnectionClosed',
  'ConnectionRefused',
])

const LOST_CONNECTION_MESSAGE =
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT)\b|socket connection was closed unexpectedly|^fetch failed/i

const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 524])

export function isLostConnectionError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 6; depth++) {
    if (current === null || typeof current !== 'object') return false
    const { code, status, message, cause } = current as {
      code?: unknown
      status?: unknown
      message?: unknown
      cause?: unknown
    }
    if (typeof code === 'string' && LOST_CONNECTION_CODES.has(code)) return true
    if (typeof status === 'number' && GATEWAY_STATUSES.has(status)) return true
    // A driver's "Failed query: …" message quotes the statement and its
    // parameters, which may hold any text; only the cause speaks for the
    // connection.
    if (
      typeof message === 'string' &&
      !message.startsWith('Failed query') &&
      LOST_CONNECTION_MESSAGE.test(message)
    ) {
      return true
    }
    current = cause
  }
  return false
}
