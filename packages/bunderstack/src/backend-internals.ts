import type { DatabaseAdapter } from './database/adapter'
import type { TickResult } from './jobs'
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

export type RuntimeJobFailure = {
  id: string
  name: string
  attempts: number
  lastError: string | null
}

export type RuntimeTestJob = {
  id: string
  name: string
  kind: 'job' | 'cron'
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  attempts: number
  runAt: number
  dedupeKey: string | null
  lastError: string | null
}

export type RuntimeTestingHandle = {
  tick(now: number): Promise<TickResult>
  inspect(now: number): Promise<{
    runnable: number
    failed: RuntimeJobFailure[]
    jobs: RuntimeTestJob[]
  }>
}

export type BackendInternals<TApp> = {
  readonly declaration: ResolvedDeclaration
  start(
    source: Record<string, string | undefined>,
    overrides?: RuntimeOverrides,
  ): Promise<TApp>
}
