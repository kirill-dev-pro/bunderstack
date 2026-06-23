import type { QueryClient, UseMutationOptions } from '@tanstack/react-query'
import type { TableAccessInput } from 'bunderstack/access'

import type { TableMutationOptions } from './mutation-options.ts'
import type { TableClient } from './table-client.ts'

export type Paginated<T> = {
  items: T[]
  limit: number
  offset?: number
  cursor?: string
  nextCursor?: string
  hasMore: boolean
  total?: number
  q?: string
  sort?: string
  order?: 'asc' | 'desc'
}

export type ListParams = {
  limit?: number
  offset?: number
  sort?: string
  order?: 'asc' | 'desc'
  q?: string
  cursor?: string
  count?: boolean
  /** Keyset pagination — first page omits offset. Used by listInfiniteQuery. */
  cursorMode?: boolean
} & Record<string, string | number | boolean | null | undefined>

export type InferSelect<T> = T extends { $inferSelect: infer R } ? R : never

export type InferInsert<T> = T extends { $inferInsert: infer R } ? R : never

export type AuthTableName = 'user' | 'session' | 'account' | 'verification'

export type CrudTableKey<TSchema extends Record<string, unknown>> = {
  [K in keyof TSchema & string]: K extends AuthTableName ? never : K
}[keyof TSchema & string]

export type CreateClientOptions<
  TSchema extends Record<string, unknown>,
  TAccess extends Record<string, TableAccessInput> | undefined = undefined,
> = {
  /** Drizzle schema object — used to resolve CRUD-exposed tables at runtime. */
  schema?: TSchema
  access?: TAccess
  /** Explicit table keys when schema cannot be imported on the client (type-only import + tables). */
  tables?: readonly (keyof TSchema & string)[]
  baseUrl?: string
  fetch?: typeof fetch
  /** TanStack Query client — enables cache invalidation in mutation options. */
  queryClient?: QueryClient
}

export type TableQueryOptions<
  TRow,
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
> = TableClient<TRow, TCreate, TUpdate> &
  TableMutationOptions<TRow, TCreate, TUpdate>

export type TableQueryOptionsForKey<
  TSchema extends Record<string, unknown>,
  K extends keyof TSchema,
> = TableQueryOptions<
  InferSelect<TSchema[K]>,
  InferInsert<TSchema[K]>,
  Partial<InferSelect<TSchema[K]>>
>

export type BunderstackQueryClient<
  TSchema extends Record<string, unknown>,
  TExposed extends keyof TSchema & string = CrudTableKey<TSchema>,
> = {
  [K in TExposed]: TableQueryOptionsForKey<TSchema, K>
}

export type ExposedTableKeys<
  TSchema extends Record<string, unknown>,
  TTables extends readonly (keyof TSchema & string)[] | undefined,
> = TTables extends readonly (keyof TSchema & string)[]
  ? TTables[number]
  : CrudTableKey<TSchema>

export type { UseMutationOptions }
