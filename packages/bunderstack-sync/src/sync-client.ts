import type { QueryClient } from '@tanstack/react-query'
import {
  attachBucketMutationOptions,
  createBucketClient,
  lazyRecord,
  type AnyBunderstackApp,
  type FilesQueryClient,
  type InferBuckets,
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
  /** Live SSE updates. Defaults to true in the browser, false during SSR. */
  realtime?: boolean
}

export type BunderstackSyncClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableCollection<
    RowFor<InferSchema<TApp>, K>,
    CreateFor<InferSchema<TApp>, K>,
    Partial<RowFor<InferSchema<TApp>, K>>
  >
} & FilesQueryClient<InferBuckets<TApp>> & {
    realtime: ReturnType<typeof createSyncRealtimeClient> | undefined
  }

/**
 * Fully typed sync client inferred from the server app. Tables (with their
 * collections and scoped/byIds views) and buckets materialize lazily on
 * first property access — no runtime table/bucket lists, and the app is
 * referenced as a type only, so no server code lands in the bundle.
 * Realtime events fan out to whichever collections have materialized.
 *
 * @example
 * import type { App } from './bunderstack'   // type-only import
 * const api = createSyncClient<App>({ queryClient })
 * api.posts.collection; api.posts.scopedCollection({ filter: { replyToId: null } })
 */
export function createSyncClient<TApp extends AnyBunderstackApp>(
  options: SyncClientOptions,
): BunderstackSyncClient<TApp> {
  const baseUrl = options.baseUrl ?? '/api'
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)

  // Realtime only needs the fan-out surface, so the map stays row-type-agnostic.
  const materialized = new Map<string, SyncRealtimeTarget>()
  const tables = lazyRecord((tableName) => {
    const bundle = createTableCollection({
      tableName,
      baseUrl,
      fetch: fetchFn,
      queryClient: options.queryClient,
    })
    materialized.set(tableName, bundle)
    return bundle
  })

  const files = lazyRecord((bucket) => {
    const bucketClient = createBucketClient({ bucket, baseUrl, fetch: fetchFn })
    return {
      ...bucketClient,
      ...attachBucketMutationOptions(bucketClient, options.queryClient),
    }
  })

  // Realtime needs a browser-side persistent connection; default off in SSR.
  const realtimeEnabled = options.realtime ?? typeof window !== 'undefined'
  const realtime = realtimeEnabled
    ? createSyncRealtimeClient({
        baseUrl,
        queryClient: options.queryClient,
        // Our public options accept any plain fetch-shaped function, while
        // the realtime client expects the ambient `typeof fetch` (which
        // includes Bun's `preconnect` static) — call-compatible otherwise.
        fetch: fetchFn as typeof fetch,
        resolve: (table) => materialized.get(table),
        resolveAll: () => materialized.values(),
      })
    : undefined

  return new Proxy({} as BunderstackSyncClient<TApp>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'files') return files
      if (prop === 'realtime') return realtime
      if (
        prop === 'then' ||
        prop === 'toJSON' ||
        prop === 'constructor' ||
        prop === '$$typeof'
      )
        return undefined
      return (tables as Record<string, unknown>)[prop]
    },
    has(_target, prop) {
      return typeof prop === 'string'
    },
  }) as BunderstackSyncClient<TApp>
}
