import type { AnyRouter } from '@orpc/server'
import type { Table } from 'drizzle-orm'

import type { AccessUser } from '../access'
import type { TableCrudProcedures } from './crud-router'

export interface ProtectedContextAdditions {
  user: AccessUser
  session: {
    activeOrganizationId: string | null
  }
}

type AuthTableName = 'user' | 'session' | 'account' | 'verification'
type InferSelect<T> = T extends { $inferSelect: infer R } ? R : never

type DisabledKeys<TAccess> = {
  [K in keyof TAccess & string]: TAccess[K] extends { crud: false } ? K : never
}[keyof TAccess & string]

type ExplicitKeys<TSchema, TAccess> = {
  [K in keyof TAccess & keyof TSchema & string]: TAccess[K] extends {
    crud: false
  }
    ? never
    : K extends AuthTableName
      ? TAccess[K] extends { exposeAuthTable: true }
        ? K extends 'user'
          ? K
          : never
        : never
      : K
}[keyof TAccess & keyof TSchema & string]

type ConventionKeys<TSchema> = {
  [K in keyof TSchema & string]: K extends AuthTableName
    ? never
    : InferSelect<TSchema[K]> extends { userId: unknown }
      ? K
      : never
}[keyof TSchema & string]

export type ExposedApiTables<TSchema, TAccess> = [TAccess] extends [undefined]
  ? ConventionKeys<TSchema>
  :
      | ExplicitKeys<TSchema, TAccess>
      | Exclude<
          ConventionKeys<TSchema>,
          DisabledKeys<TAccess> | (keyof TAccess & string)
        >

/**
 * Column allowlists declared in `access` reach the client as literal unions, so
 * `list` can type `filters` and `sort` per table. Tables that declare nothing
 * get `never` filters and `'id'` sorting, matching the runtime defaults.
 */
type FilterableOf<TAccess, K extends string> = K extends keyof TAccess
  ? TAccess[K] extends {
      filterableColumns: readonly (infer F extends string)[]
    }
    ? F
    : never
  : never

type SortableOf<TAccess, K extends string> = K extends keyof TAccess
  ? TAccess[K] extends { sortableColumns: readonly (infer S extends string)[] }
    ? S
    : 'id'
  : 'id'

export type CrudApiRouterFor<
  TSchema extends Record<string, unknown>,
  TAccess = undefined,
> = {
  [K in ExposedApiTables<TSchema, TAccess> as TSchema[K] extends Table
    ? K
    : never]: TableCrudProcedures<
    Extract<TSchema[K], Table>,
    FilterableOf<TAccess, K>,
    SortableOf<TAccess, K>
  >
}

type IsProcedure<T> = T extends { '~orpc': unknown } ? true : false

export type MergeApiRouterTypes<A, B> = {
  [K in keyof A | keyof B]: K extends keyof A
    ? K extends keyof B
      ? IsProcedure<A[K]> extends true
        ? never
        : IsProcedure<B[K]> extends true
          ? never
          : A[K] extends Record<string, unknown>
            ? B[K] extends Record<string, unknown>
              ? MergeApiRouterTypes<A[K], B[K]>
              : never
            : never
      : A[K]
    : K extends keyof B
      ? B[K]
      : never
}

export type UnifiedApiRouter<
  TCrud,
  TCustom extends AnyRouter | undefined,
> = TCustom extends AnyRouter ? MergeApiRouterTypes<TCrud, TCustom> : TCrud
