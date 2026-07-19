import { getTableName, type InferSelectModel, type Table } from 'drizzle-orm'

import type { RealtimeAction, RealtimeBroker } from './index'

export type SchemaTable<TSchema extends Record<string, unknown>> = Extract<
  TSchema[keyof TSchema],
  Table
>

export interface RealtimeFacade<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly enabled: boolean

  publish<TTable extends SchemaTable<TSchema>>(
    table: TTable,
    action: RealtimeAction,
    record: InferSelectModel<TTable>,
  ): Promise<void>
}

export function createRealtimeFacade<TSchema extends Record<string, unknown>>(
  broker?: RealtimeBroker,
): RealtimeFacade<TSchema> {
  return {
    enabled: broker !== undefined,
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
