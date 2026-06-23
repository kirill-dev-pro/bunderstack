/**
 * @deprecated Import from `bunderstack-query` directly — `createBunderstackQueryClient` accepts `queryClient`.
 */
export {
  createBunderstackQueryClient,
  createBunderstackQueryClient as createBunderstackReactQueryClient,
  BunderstackApiError,
} from './index.ts'
export type {
  BunderstackQueryClient,
  BunderstackQueryClient as BunderstackReactQueryClient,
  Paginated,
  ListParams,
  InferSelect,
  InferInsert,
} from './types.ts'
