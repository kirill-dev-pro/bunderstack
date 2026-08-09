import type { AnyRouter } from '@orpc/server'
import type { Table } from 'drizzle-orm'
import type { TableCrudProcedures } from './crud-router'

type AuthTableName = 'user' | 'session' | 'account' | 'verification'
type InferSelect<T> = T extends { $inferSelect: infer R } ? R : never

type CrudApiTableKey<TSchema> = {
  [K in keyof TSchema & string]: K extends AuthTableName ? never : K
}[keyof TSchema & string]

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
  ? CrudApiTableKey<TSchema>
  :
      | ExplicitKeys<TSchema, TAccess>
      | Exclude<
          ConventionKeys<TSchema>,
          DisabledKeys<TAccess> | (keyof TAccess & string)
        >

export type CrudApiRouterFor<
  TSchema extends Record<string, unknown>,
  TAccess = undefined,
> = {
  [K in ExposedApiTables<TSchema, TAccess> as TSchema[K] extends Table
    ? K
    : never]: TableCrudProcedures<Extract<TSchema[K], Table>>
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
  TCrud extends AnyRouter,
  TCustom extends AnyRouter | undefined,
> = TCustom extends AnyRouter ? MergeApiRouterTypes<TCrud, TCustom> : TCrud
