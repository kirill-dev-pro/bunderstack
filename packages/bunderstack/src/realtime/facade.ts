import { getTableName, type InferSelectModel, type Table } from 'drizzle-orm'

import type {
  RealtimeAction,
  RealtimePublisher,
} from './publisher'

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
  publisher?: RealtimePublisher,
  transport: RealtimeTransport = publisher ? 'memory' : 'disabled',
): RealtimeFacade<TSchema> {
  if (!publisher && transport !== 'disabled') {
    throw new Error(
      '[bunderstack] an enabled realtime transport requires a publisher',
    )
  }
  if (publisher && transport === 'disabled') {
    throw new Error(
      '[bunderstack] a realtime publisher cannot use the disabled transport',
    )
  }

  return {
    enabled: publisher !== undefined,
    transport,
    async publish(table, action, record) {
      if (!publisher) return
      await publisher.publish('change', {
        table: getTableName(table),
        action,
        record: record as unknown as Record<string, unknown>,
      })
    },
  }
}
