import {
  getTableName,
  isTable,
  type InferSelectModel,
  type Table,
} from 'drizzle-orm'

import type { RealtimeAction, RealtimePublisher } from './publisher'

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
    metadata?: { operationId?: string },
  ): Promise<void>
}

/**
 * One name for a table everywhere: events, subscriptions, and the CRUD router
 * all use the schema key. Pass the schema so a key like `creditBalances` is not
 * published as its SQL name `credit_balances` — clients subscribe with the key
 * they call procedures with. Without a schema, the SQL name is the only name
 * available and is used as-is.
 */
export function createRealtimeFacade<TSchema extends Record<string, unknown>>(
  publisher?: RealtimePublisher,
  transport: RealtimeTransport = publisher ? 'memory' : 'disabled',
  schema?: TSchema,
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

  const keyByTableName = new Map<string, string>()
  for (const [key, value] of Object.entries(schema ?? {})) {
    if (isTable(value)) keyByTableName.set(getTableName(value), key)
  }

  return {
    enabled: publisher !== undefined,
    transport,
    async publish(table, action, record, metadata) {
      if (!publisher) return
      const tableName = getTableName(table)
      await publisher.publish('change', {
        table: keyByTableName.get(tableName) ?? tableName,
        action,
        record: record as unknown as Record<string, unknown>,
        ...(metadata?.operationId ? { operationId: metadata.operationId } : {}),
      })
    },
  }
}
