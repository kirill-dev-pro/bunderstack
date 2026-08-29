import '@orpc/openapi/extensions/route'
import type { AnyMiddleware } from '@orpc/server'

import * as v from 'valibot'

import type { ReadinessReport } from '../readiness'

import { readinessReportSchema } from '../readiness'
import { createApiBuilder } from './builder'
import { mergeApiRoutersStrict } from './registry'

export interface BuildApiRouterOptions {
  crud: Record<string, unknown>
  storage: Record<string, unknown>
  realtime?: Record<string, unknown>
  custom?: Record<string, unknown>
  /** Applied to every procedure in the graph, outermost first. */
  middleware?: AnyMiddleware[]
  /** Deployment readiness probe. Always answers 200; read `status` in the body. */
  readiness: () => Promise<ReadinessReport>
}

export function buildApiRouter(options: BuildApiRouterOptions) {
  const builder = createApiBuilder<
    Record<string, unknown>,
    Record<string, unknown>
  >()
  const health = builder.public
    .route({ method: 'GET', path: '/api/health', tags: ['system'] })
    .output(v.strictObject({ status: v.literal('ok') }))
    .handler(() => ({ status: 'ok' as const }))

  const readiness = builder.public
    .route({ method: 'GET', path: '/api/readiness', tags: ['system'] })
    .output(readinessReportSchema)
    .handler(() => options.readiness())

  const merged = [
    { health, readiness },
    options.crud,
    options.storage,
    options.realtime,
    options.custom,
  ].reduce<Record<string, unknown>>(
    (router, addition) => mergeApiRoutersStrict(router, addition),
    {},
  )

  const middleware = options.middleware ?? []
  if (middleware.length === 0) return merged

  // `.router()` applies the builder's middleware to every procedure inside, so
  // one list covers CRUD, storage, realtime, health, readiness, and custom procedures
  // instead of only the bases an application happens to declare.
  const withMiddleware = middleware.reduce(
    (acc, mw) => acc.use(mw as never),
    builder.public,
  )

  return withMiddleware.router(merged as never) as Record<string, unknown>
}
