import type { QueryClient } from '@tanstack/react-query'

import type {
  AnyBunderstackApp,
  InferBuckets,
  InferSchema,
  InferTables,
} from './infer'
import type { FilesQueryClient, TableQueryOptionsForKey } from './types'

import {
  attachBucketMutationOptions,
  createBucketClient,
} from './bucket-client'
import { attachMutationOptions } from './mutation-options'
import { createTableClient } from './table-client'

export type ClientOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient?: QueryClient
}

export type BunderstackClient<TApp extends AnyBunderstackApp> = {
  [K in InferTables<TApp>]: TableQueryOptionsForKey<InferSchema<TApp>, K>
} & FilesQueryClient<InferBuckets<TApp>>

/** Props a lazy Proxy must not materialize (await/introspection probes). */
const PROXY_SKIP = new Set<string>([
  'then',
  'toJSON',
  'constructor',
  '$$typeof',
])

/**
 * Record whose values are created on first property access and cached, so
 * repeated reads return the same instance. Keys are open-ended — the caller's
 * type layer constrains which keys are valid. Note `Object.keys()` on the
 * result is empty by design.
 */
export function lazyRecord<T>(create: (key: string) => T): Record<string, T> {
  const cache = new Map<string, T>()
  return new Proxy({} as Record<string, T>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || PROXY_SKIP.has(prop)) return undefined
      let value = cache.get(prop)
      if (value === undefined) {
        value = create(prop)
        cache.set(prop, value)
      }
      return value
    },
    has(_target, prop) {
      return typeof prop === 'string' && !PROXY_SKIP.has(prop)
    },
  })
}

/**
 * Fully typed client inferred from the server app — tables and buckets come
 * from `typeof app`, materialized lazily on first property access. No
 * runtime table/bucket lists, and no server code in the bundle (the app is
 * referenced as a type only).
 *
 * @example
 * import type { App } from './bunderstack'   // type-only import
 * const api = createClient<App>({ queryClient })
 * api.posts.list(); api.files.images.upload(file)
 */
export function createClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): BunderstackClient<TApp> {
  const baseUrl = options.baseUrl ?? '/api'
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)

  const files = lazyRecord((bucket) => {
    const bucketClient = createBucketClient({ bucket, baseUrl, fetch: fetchFn })
    return {
      ...bucketClient,
      ...attachBucketMutationOptions(bucketClient, options.queryClient),
    }
  })

  const tables = lazyRecord((tableName) => {
    const tableClient = createTableClient({
      tableName,
      baseUrl,
      fetch: fetchFn,
    })
    return {
      ...tableClient,
      ...attachMutationOptions(tableClient, options.queryClient),
    }
  })

  return new Proxy({} as BunderstackClient<TApp>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || PROXY_SKIP.has(prop)) return undefined
      if (prop === 'files') return files
      return (tables as Record<string, unknown>)[prop]
    },
    has(_target, prop) {
      return typeof prop === 'string' && !PROXY_SKIP.has(prop)
    },
  }) as BunderstackClient<TApp>
}
