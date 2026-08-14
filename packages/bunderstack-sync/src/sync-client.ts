import type { QueryClient } from '@tanstack/react-query'

import {
  createClient,
  type AnyBunderstackApp,
  type BunderstackClient,
  type InferInsert,
  type InferSchema,
  type InferSelect,
  type InferTables,
} from 'bunderstack-query'

import { createTableCollection, type TableCollection } from './collection'
import {
  createSyncRealtimeClient,
  type SyncRealtimeTarget,
} from './realtime-sync'

export type RowFor<
  TSchema extends Record<string, unknown>,
  K extends keyof TSchema,
> = [InferSelect<TSchema[K]>] extends [never]
  ? { id: string | number }
  : InferSelect<TSchema[K]> extends { id: string | number }
    ? InferSelect<TSchema[K]>
    : { id: string | number }

export type CreateFor<
  TSchema extends Record<string, unknown>,
  K extends keyof TSchema,
> = [InferInsert<TSchema[K]>] extends [never]
  ? Partial<RowFor<TSchema, K>>
  : InferInsert<TSchema[K]>

export type SyncClientOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
  realtime?: boolean
}

export type BunderstackSyncClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableCollection<
    RowFor<InferSchema<TApp>, K>,
    CreateFor<InferSchema<TApp>, K>,
    Partial<RowFor<InferSchema<TApp>, K>>
  >
} & {
  files: BunderstackClient<TApp>['files']
  realtime:
    | { close(): void; subscribe(tables: string[]): Promise<void> }
    | undefined
}

export function createSyncClient<TApp extends AnyBunderstackApp>(
  options: SyncClientOptions,
): BunderstackSyncClient<TApp> {
  const api = createClient<TApp>(options)
  const materialized = new Map<string, SyncRealtimeTarget>()
  const realtimeHandles = new Map<string, { close(): void }>()
  const tables = new Map<string, unknown>()
  const realtimeEnabled = options.realtime ?? typeof window !== 'undefined'

  const result = new Proxy({} as BunderstackSyncClient<TApp>, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      if (property === 'files') return api.files
      if (property === 'realtime') {
        return realtimeEnabled
          ? {
              close: () => realtimeHandles.forEach((handle) => handle.close()),
              subscribe: async (names: string[]) => {
                for (const name of names) void (result as any)[name]
              },
            }
          : undefined
      }
      if (['then', 'toJSON', 'constructor', '$$typeof'].includes(property))
        return undefined
      const cached = tables.get(property)
      if (cached) return cached
      const collection = createTableCollection({
        tableName: property,
        procedures: (api as any)[property],
        queryClient: options.queryClient,
      })
      tables.set(property, collection)
      materialized.set(property, collection)
      if (realtimeEnabled) {
        realtimeHandles.set(
          property,
          createSyncRealtimeClient({
            api: api as any,
            queryClient: options.queryClient,
            tables: [property],
            resolve: (table) => materialized.get(table),
            resolveAll: () => materialized.values(),
          }),
        )
      }
      return collection
    },
  })
  return result
}
