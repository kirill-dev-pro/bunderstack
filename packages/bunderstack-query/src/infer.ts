import type { AuthTableName, CrudTableKey, InferSelect } from './types'

/** Shape of the `$inferClient` phantom `createBunderstack` puts on the app. */
export type ClientCarrier = {
  schema: Record<string, unknown>
  access: unknown
  buckets: string
}

export type AnyBunderstackApp = { $inferClient?: ClientCarrier | undefined }

export type InferCarrier<TApp extends AnyBunderstackApp> = NonNullable<
  TApp['$inferClient']
>
export type InferSchema<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['schema']
export type InferBuckets<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['buckets']

type DisabledKeys<TAccess> = {
  [K in keyof TAccess & string]: TAccess[K] extends { crud: false } ? K : never
}[keyof TAccess & string]

/** Tables with an explicit access entry (auth tables need exposeAuthTable). */
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

/** Tables with a `userId` column get convention CRUD without an access entry. */
type ConventionKeys<TSchema> = {
  [K in keyof TSchema & string]: K extends AuthTableName
    ? never
    : InferSelect<TSchema[K]> extends { userId: unknown }
      ? K
      : never
}[keyof TSchema & string]

/**
 * Type-level mirror of validateAndResolveAccess's exposure rules. Slightly
 * permissive on edge cases (a wrongly-included table 404s at runtime, same
 * as a hand-written tables tuple — never silently narrower).
 */
export type ExposedTables<TSchema extends Record<string, unknown>, TAccess> = [
  TAccess,
] extends [undefined]
  ? CrudTableKey<TSchema>
  :
      | ExplicitKeys<TSchema, TAccess>
      | Exclude<
          ConventionKeys<TSchema>,
          DisabledKeys<TAccess> | (keyof TAccess & string)
        >

export type InferTables<TApp extends AnyBunderstackApp> = ExposedTables<
  InferSchema<TApp>,
  InferCarrier<TApp>['access']
> &
  keyof InferSchema<TApp> &
  string
