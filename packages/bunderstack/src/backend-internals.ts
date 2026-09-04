import type { EnvConfigInput } from './env'
import type { InspectedDefinition } from './inspect'
import type { TickResult } from './jobs'
import type { RuntimeOverrides } from './runtime'

export const BACKEND_INTERNALS: unique symbol = Symbol.for(
  'bunderstack.backend-internals',
)

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
  readonly envSchema: EnvConfigInput | undefined
  inspect(source: Record<string, string | undefined>): InspectedDefinition
  start(
    source: Record<string, string | undefined>,
    overrides?: RuntimeOverrides,
    inspected?: InspectedDefinition,
  ): Promise<TApp>
}
