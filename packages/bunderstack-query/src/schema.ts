import type { QueryClient } from '@tanstack/react-query'
import {
  validateAndResolveAccess,
  type TableAccessInput,
} from 'bunderstack/access'

import type {
  BunderstackQueryClient,
  CrudTableKey,
  InferInsert,
  InferSelect,
  TableQueryOptions,
} from './types'

import { attachMutationOptions } from './mutation-options'
import { createTableClient } from './table-client'

type BaseOptions = {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  queryClient?: QueryClient
}

export function buildTableQueryOptions<
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

export function createBunderstackSchemaClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>() {
  return {
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
  }
}
