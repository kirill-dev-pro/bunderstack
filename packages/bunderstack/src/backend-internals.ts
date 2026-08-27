import type { DatabaseAdapter } from './database/adapter'
import type { RuntimeOverrides } from './runtime'
import type { StorageConfigInput } from './storage/buckets'

export const BACKEND_INTERNALS: unique symbol = Symbol.for(
  'bunderstack.backend-internals',
)

export type ResolvedDeclaration = {
  readonly config: {
    readonly database: { readonly adapter: DatabaseAdapter }
    readonly storage?: StorageConfigInput
  }
  readonly jobsDefs: unknown
}

export type BackendInternals<TApp> = {
  readonly declaration: ResolvedDeclaration
  start(
    source: Record<string, string | undefined>,
    overrides?: RuntimeOverrides,
  ): Promise<TApp>
}
