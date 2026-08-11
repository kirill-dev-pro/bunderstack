import { eventIterator } from '@orpc/server'
import '@orpc/openapi/extensions/route'
import * as v from 'valibot'

import type { ResolvedAccess } from '../access'
import type { RealtimePublisher } from '../realtime/publisher'

import { filterRealtimeChanges } from '../realtime/filter'
import { createApiBuilder } from './builder'

const tablesSchema = v.pipe(
  v.union([v.string(), v.array(v.string())]),
  v.transform((value) => (Array.isArray(value) ? value : [value])),
)

const changeSchema = v.strictObject({
  table: v.string(),
  action: v.picklist(['create', 'update', 'delete']),
  record: v.record(v.string(), v.unknown()),
})

export function buildRealtimeApiRouter(
  publisher: RealtimePublisher | undefined,
  access: ResolvedAccess,
) {
  if (!publisher) return undefined
  const builder = createApiBuilder<
    Record<string, unknown>,
    Record<string, unknown>
  >()

  const changes = builder.public
    .route({
      method: 'GET',
      path: '/api/realtime',
      summary: 'Subscribe to realtime changes',
      tags: ['realtime'],
      queryStyles: { tables: 'array' },
    })
    .input(v.strictObject({ tables: tablesSchema }))
    .output(eventIterator(changeSchema))
    .handler(({ input, context, signal, lastEventId }) =>
      filterRealtimeChanges(
        publisher.subscribe('change', { signal, lastEventId }),
        {
          subscriptions: input.tables,
          access,
          request: context.request,
          getSession: context.getSession,
        },
      ),
    )

  return { realtime: { changes } }
}

export type RealtimeApiRouter = NonNullable<
  ReturnType<typeof buildRealtimeApiRouter>
>
