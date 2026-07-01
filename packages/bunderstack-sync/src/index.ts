import type { QueryClient } from '@tanstack/react-query'
import {
  createBunderstackQueryClient,
  type FilesQueryClient,
  BunderstackApiError,
  type InferSelect,
  type InferInsert,
  type UploadedFile,
} from 'bunderstack-query'

import { createTableCollection, type TableCollection } from './collection'
import { createSyncRealtimeClient } from './realtime-sync'

type BaseOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient: QueryClient
}

type RowFor<
  TSchema extends Record<string, unknown>,
  K extends keyof TSchema,
> = [InferSelect<TSchema[K]>] extends [never]
  ? { id: string | number }
  : InferSelect<TSchema[K]> extends { id: string | number }
  ? InferSelect<TSchema[K]>
  : { id: string | number }

type CreateFor<
  TSchema extends Record<string, unknown>,
  K extends keyof TSchema,
> = [InferInsert<TSchema[K]>] extends [never]
  ? Partial<RowFor<TSchema, K>>
  : InferInsert<TSchema[K]>

type SyncTablesClient<
  TSchema extends Record<string, unknown>,
  TTable extends keyof TSchema & string,
> = {
  [K in TTable]: TableCollection<
    RowFor<TSchema, K>,
    CreateFor<TSchema, K>,
    Partial<RowFor<TSchema, K>>
  >
}

export function createBunderstackSyncClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>() {
  return {
    with<
      const TTables extends readonly (keyof TSchema & string)[],
      const TBuckets extends readonly string[],
    >(
      options: BaseOptions & {
        tables: TTables
        buckets: TBuckets
        /** Subscribe these tables to live SSE updates. Defaults to true. */
        realtime?: boolean
      },
    ) {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)

      const tablesClient: Record<
        string,
        ReturnType<typeof createTableCollection>
      > = {}
      for (const tableKey of options.tables) {
        tablesClient[tableKey] = createTableCollection({
          tableName: tableKey,
          baseUrl,
          fetch: fetchFn,
          queryClient: options.queryClient,
        })
      }

      const filesClient: FilesQueryClient<TBuckets[number]> =
        createBunderstackQueryClient<TSchema>().withFiles({
          baseUrl,
          fetch: fetchFn,
          buckets: options.buckets,
          queryClient: options.queryClient,
        })

      const realtime =
        options.realtime === false
          ? undefined
          : createSyncRealtimeClient({
              baseUrl,
              queryClient: options.queryClient,
              // `createSyncRealtimeClient` expects the ambient `typeof fetch`
              // (which includes Bun's `preconnect` static), while our public
              // options accept any plain fetch-shaped function — the two
              // signatures are otherwise call-compatible.
              fetch: fetchFn as typeof fetch,
              // Individual collections are typed against their own row shape
              // (inferred from `createTableCollection`'s constraint since
              // this loop can't carry a per-key TRow), which is narrower
              // than `SyncableCollection`'s `unknown`-typed utils. Safe here
              // because `realtime-sync.ts` only ever passes server-decoded
              // records through, matching each collection's own row shape.
              collections: Object.fromEntries(
                Object.entries(tablesClient).map(([k, v]) => [
                  k,
                  v.collection,
                ]),
              ) as unknown as Record<
                string,
                Parameters<typeof createSyncRealtimeClient>[0]['collections'][string]
              >,
            })

      return {
        ...tablesClient,
        ...filesClient,
        realtime,
      } as unknown as SyncTablesClient<TSchema, TTables[number]> &
        FilesQueryClient<TBuckets[number]> & {
          realtime: typeof realtime
        }
    },
  }
}

export { createTableCollection } from './collection'
export type { TableCollection, TableCollectionConfig } from './collection'
export { createSyncRealtimeClient } from './realtime-sync'
export type { SyncRealtimeConfig } from './realtime-sync'

// Re-export bunderstack-query types and utilities for convenience
export { BunderstackApiError } from 'bunderstack-query'
export type { InferSelect, InferInsert, UploadedFile } from 'bunderstack-query'
