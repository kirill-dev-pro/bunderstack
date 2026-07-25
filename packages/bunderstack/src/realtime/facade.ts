import { getTableName, type InferSelectModel, type Table } from 'drizzle-orm'

import type { RealtimeAction, RealtimeBroker } from './index'

export type RealtimeTransport = 'disabled' | 'memory' | 'redis'

export type SchemaTable<TSchema extends Record<string, unknown>> = Extract<
  TSchema[keyof TSchema],
  Table
>

export interface RealtimeFacade<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly enabled: boolean
  readonly transport: RealtimeTransport

  publish<TTable extends SchemaTable<TSchema>>(
    table: TTable,
    action: RealtimeAction,
    record: InferSelectModel<TTable>,
  ): Promise<void>
}

export function createRealtimeFacade<TSchema extends Record<string, unknown>>(
  broker?: RealtimeBroker,
  transport: RealtimeTransport = broker ? 'memory' : 'disabled',
): RealtimeFacade<TSchema> {
  if (!broker && transport !== 'disabled') {
    throw new Error(
      '[bunderstack] an enabled realtime transport requires a broker',
    )
  }
  if (broker && transport === 'disabled') {
    throw new Error(
      '[bunderstack] a realtime broker cannot use the disabled transport',
    )
  }

  return {
    enabled: broker !== undefined,
    transport,
    async publish(table, action, record) {
      if (!broker) return
      await broker.publish(
        getTableName(table),
        action,
        record as unknown as Record<string, unknown>,
      )
    },
  }
}
