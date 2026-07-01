import type { QueryClient } from '@tanstack/react-query'

import {
  validateAndResolveAccess,
  type TableAccessInput,
} from 'bunderstack/access'

import type {
  BunderstackQueryClient,
  CrudTableKey,
  FilesQueryClient,
  InferInsert,
  InferSelect,
  TableQueryOptions,
} from './types'

import {
  attachBucketMutationOptions,
  createBucketClient,
} from './bucket-client'
import { attachMutationOptions } from './mutation-options'
import { createTableClient } from './table-client'

type BaseOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient?: QueryClient
}

function buildTableQueryOptions<
  TSchema extends Record<string, unknown>,
  K extends keyof TSchema & string,
>(
  _tableKey: K,
  tableName: string,
  table: TSchema[K] | undefined,
  config: BaseOptions & {
    baseUrl: string
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  },
): TableQueryOptions<
  InferSelect<NonNullable<typeof table>>,
  InferInsert<NonNullable<typeof table>>,
  Partial<InferSelect<NonNullable<typeof table>>>
> {
  type Row = InferSelect<NonNullable<typeof table>>
  type Create = InferInsert<NonNullable<typeof table>>
  type Update = Partial<Row>

  const client = createTableClient<Row, Create, Update>({
    tableName,
    baseUrl: config.baseUrl,
    fetch: config.fetch,
  })

  return {
    ...client,
    ...attachMutationOptions(client, config.queryClient),
  }
}

export function createBunderstackQueryClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>() {
  return {
    /**
     * Tables path: provide TSchema explicitly as a generic, TTables is inferred from the tuple.
     * The schema is never imported as a value — safe for client bundles.
     *
     * @example
     * import type * as schema from './schema'
     * const api = createBunderstackQueryClient<typeof schema>()
     *   .withTables({ queryClient, tables: ['posts', 'user'] as const })
     */
    withTables<const TTables extends readonly (keyof TSchema & string)[]>(
      options: BaseOptions & { tables: TTables },
    ): BunderstackQueryClient<TSchema, TTables[number]> {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
      const client = {} as BunderstackQueryClient<TSchema, TTables[number]>

      for (const tableKey of options.tables) {
        const tableClient = createTableClient({
          tableName: tableKey,
          baseUrl,
          fetch: fetchFn,
        })
        ;(client as Record<string, unknown>)[tableKey] = {
          ...tableClient,
          ...attachMutationOptions(tableClient, options.queryClient),
        }
      }
      return client
    },

    /**
     * Schema path: TSchema is inferred from the schema value. Exposed tables are determined
     * by access rules (auth tables excluded by default via CrudTableKey).
     *
     * @example
     * import * as schema from './schema'
     * const api = createBunderstackQueryClient()
     *   .withSchema({ schema, queryClient })
     */
    withSchema<
      S extends TSchema,
      TAccess extends Record<string, TableAccessInput> | undefined = undefined,
    >(
      options: BaseOptions & { schema: S; access?: TAccess },
    ): BunderstackQueryClient<S, CrudTableKey<S>> {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
      const client = {} as BunderstackQueryClient<S, CrudTableKey<S>>
      const config = {
        baseUrl,
        fetch: fetchFn,
        queryClient: options.queryClient,
      }

      const resolved = validateAndResolveAccess(options.schema, options.access)
      for (const [tableKey, tableAccess] of resolved) {
        if (!tableAccess.enabled) continue
        ;(client as Record<string, unknown>)[tableKey] = buildTableQueryOptions(
          tableKey as keyof S & string,
          tableAccess.tableName,
          options.schema[tableKey],
          config,
        )
      }
      return client
    },

    withFiles<const TBuckets extends readonly string[]>(
      options: BaseOptions & { buckets: TBuckets },
    ): FilesQueryClient<TBuckets[number]> {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
      const client: FilesQueryClient<TBuckets[number]> = {
        files: {} as FilesQueryClient<TBuckets[number]>['files'],
      }

      for (const bucket of options.buckets) {
        const bucketClient = createBucketClient({
          bucket,
          baseUrl,
          fetch: fetchFn,
        })
        client.files[bucket as TBuckets[number]] = {
          ...bucketClient,
          ...attachBucketMutationOptions(bucketClient, options.queryClient),
        }
      }
      return client
    },

    with<
      const TTables extends readonly (keyof TSchema & string)[],
      const TBuckets extends readonly string[],
    >(
      options: BaseOptions & { tables: TTables; buckets: TBuckets },
    ): BunderstackQueryClient<TSchema, TTables[number]> &
      FilesQueryClient<TBuckets[number]> {
      const baseUrl = options.baseUrl ?? '/api'
      const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
      const tablesClient = {} as BunderstackQueryClient<
        TSchema,
        TTables[number]
      >

      for (const tableKey of options.tables) {
        const tableClient = createTableClient({
          tableName: tableKey,
          baseUrl,
          fetch: fetchFn,
        })
        ;(tablesClient as Record<string, unknown>)[tableKey] = {
          ...tableClient,
          ...attachMutationOptions(tableClient, options.queryClient),
        }
      }

      const filesClient: FilesQueryClient<TBuckets[number]> = {
        files: {} as FilesQueryClient<TBuckets[number]>['files'],
      }
      for (const bucket of options.buckets) {
        const bucketClient = createBucketClient({
          bucket,
          baseUrl,
          fetch: fetchFn,
        })
        filesClient.files[bucket as TBuckets[number]] = {
          ...bucketClient,
          ...attachBucketMutationOptions(bucketClient, options.queryClient),
        }
      }

      return {
        ...tablesClient,
        ...filesClient,
      }
    },
  }
}

export { BunderstackApiError } from './errors'
export type {
  BunderstackQueryClient,
  CreateClientOptions,
  CrudTableKey,
  ExposedTableKeys,
  FilesQueryClient,
  InferInsert,
  InferSelect,
  ListParams,
  Paginated,
  TableQueryOptions,
  TableQueryOptionsForKey,
  UseMutationOptions,
} from './types'
export {
  createBucketClient,
  attachBucketMutationOptions,
} from './bucket-client'
export type {
  BucketClient,
  BucketClientConfig,
  BucketMutationOptions,
  FileTransformOptions,
  UploadedFile,
  UploadMode,
  UploadOptions,
} from './bucket-client'
export { createTableClient } from './table-client'
export type { TableClient, TableClientConfig } from './table-client'
export { createRealtimeClient } from './realtime-client'
export type { RealtimeClientConfig, RealtimeEvent } from './realtime-client'
