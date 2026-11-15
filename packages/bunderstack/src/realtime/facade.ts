import {
  getTableName,
  isTable,
  type InferSelectModel,
  type Table,
} from 'drizzle-orm'

import type { BunderstackLogger } from '../logging'
import type { RealtimeAction, RealtimePublisher } from './publisher'

import { consoleLogger } from '../logging'

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

  /**
   * Announce a write that has already happened. It never throws: a Redis that
   * is down or slow costs subscribers one live update (they catch up when
   * they resubscribe), not the request that made the write, which a client
   * would otherwise see fail and send again.
   */
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
  logger: Pick<BunderstackLogger, 'warn'> = consoleLogger,
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
      const key = keyByTableName.get(tableName) ?? tableName
      try {
        await publisher.publish('change', {
          table: key,
          action,
          record: record as unknown as Record<string, unknown>,
          ...(metadata?.operationId
            ? { operationId: metadata.operationId }
            : {}),
        })
      } catch (error) {
        logger.warn(
          `[bunderstack] realtime: the ${action} of a \`${key}\` row was saved, ` +
            `but announcing it to subscribers failed (${transport}): ` +
            describe(error),
        )
      }
    },
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && !error.message.includes(code)
    ? `${error.name}: ${error.message} (${code})`
    : `${error.name}: ${error.message}`
}
