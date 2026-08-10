import type { ExposedApiTables } from 'bunderstack/api'

/** Shape of the `$inferClient` phantom `createBunderstack` puts on the app. */
export type ClientCarrier = {
  schema: Record<string, unknown>
  access: unknown
  buckets: string
  // Optional: apps built before the trpc feature still match.
  trpc?: unknown
}

export type AnyBunderstackApp = { $inferClient?: ClientCarrier | undefined }

export type InferCarrier<TApp extends AnyBunderstackApp> = NonNullable<
  TApp['$inferClient']
>
export type InferSchema<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['schema']
export type InferBuckets<TApp extends AnyBunderstackApp> =
  InferCarrier<TApp>['buckets']

/** The app's tRPC router type, or `never` when it doesn't declare one. */
export type InferTrpcRouter<TApp extends AnyBunderstackApp> = Exclude<
  InferCarrier<TApp>['trpc'],
  undefined
>

export type ExposedTables<
  TSchema extends Record<string, unknown>,
  TAccess = undefined,
> = ExposedApiTables<TSchema, TAccess>

export type InferTables<TApp extends AnyBunderstackApp> = ExposedTables<
  InferSchema<TApp>,
  InferCarrier<TApp>['access']
> &
  keyof InferSchema<TApp> &
  string
