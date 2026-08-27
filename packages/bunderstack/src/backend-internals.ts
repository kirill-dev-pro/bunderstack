import type { RuntimeOverrides } from './runtime'

export const BACKEND_INTERNALS: unique symbol = Symbol.for(
  'bunderstack.backend-internals',
)

export type BackendInternals<TApp> = {
  readonly declaration: unknown
  start(
    source: Record<string, string | undefined>,
    overrides?: RuntimeOverrides,
  ): Promise<TApp>
}
