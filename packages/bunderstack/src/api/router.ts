import '@orpc/openapi/extensions/route'
import * as v from 'valibot'

import { createApiBuilder } from './builder'
import { mergeApiRoutersStrict } from './registry'

export interface BuildApiRouterOptions {
  crud: Record<string, unknown>
  storage: Record<string, unknown>
  realtime?: Record<string, unknown>
  custom?: Record<string, unknown>
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

  return [
    { health },
    options.crud,
    options.storage,
    options.realtime,
    options.custom,
  ].reduce<Record<string, unknown>>(
    (router, addition) => mergeApiRoutersStrict(router, addition),
    {},
  )
}
