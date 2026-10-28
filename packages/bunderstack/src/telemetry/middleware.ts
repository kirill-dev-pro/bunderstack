import { ORPCError, os, type AnyMiddleware } from '@orpc/server'

import type { TelemetrySink } from './telemetry'

import { httpStatusOf } from '../errors'

// Times every procedure and captures what failed unexpectedly. Prepended to
// the application's own middleware list in the runtime, so it is outermost for
// CRUD, storage, custom, health and readiness procedures alike. Subscriptions
// (`realtime.*`) live as long as the connection and are not timed.

type PeekingContext = {
  request?: Request
  peekSession?: () => { user: unknown } | undefined
}

/** Procedures whose timing says nothing about the application. */
const SKIPPED = new Set(['health', 'readiness'])

export function telemetryMiddleware(telemetry: TelemetrySink): AnyMiddleware {
  return os.middleware(async ({ context, next, path }) => {
    if (path[0] === 'realtime' || (path.length === 1 && SKIPPED.has(path[0]!)))
      return next()
    const route = path.join('.')
    const startedAt = performance.now()
    let status = 200
    try {
      return await next()
    } catch (error) {
      status = error instanceof ORPCError ? httpStatusOf(error) : 500
      if (status >= 500) {
        const ctx = context as PeekingContext
        const url = ctx.request ? safePathname(ctx.request.url) : undefined
        telemetry.captureException(
          error instanceof ORPCError && error.cause !== undefined
            ? error.cause
            : error,
          {
            source: 'api',
            procedure: route,
            method: ctx.request?.method,
            path: url,
            status,
            hasSession: Boolean(ctx.peekSession?.()?.user),
            ...(error instanceof ORPCError ? { code: error.code } : {}),
          },
        )
      }
      throw error
    } finally {
      telemetry.recordRequest({
        route,
        status,
        durationMs: performance.now() - startedAt,
      })
    }
  }) as AnyMiddleware
}

function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}
