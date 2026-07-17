// src/jobs/define.ts — job definition types and the typed builder.
// `createJobsBuilder` mirrors `createTRPC`: it exists purely to carry
// TSchema/TEnvResult typing into inline callbacks and extracted files.
import type { ZodType } from 'zod'

import type { DbFor } from '../db'
import type { EmailFacade } from '../email'
import type { StorageFacade } from '../index'

import { parseCron } from './cron'

export const DEFAULT_RETRIES = 3
export const DEFAULT_TIMEOUT_MS = 60_000

export type EnqueueOptions = {
  /** Collapse duplicate enqueues; see spec for cron vs non-cron lifetime. */
  dedupeKey?: string
  /** Milliseconds from now until the job becomes claimable. */
  delay?: number
  /** Absolute time the job becomes claimable; wins over `delay`. */
  runAt?: Date | number
}

/**
 * The untyped runtime facade. Handler ctx and tRPC ctx expose this shape;
 * `app.jobs` narrows `enqueue` to the declared job names/payloads.
 */
export type JobsRuntimeFacade = {
  enqueue(
    name: string,
    input?: unknown,
    opts?: EnqueueOptions,
  ): Promise<{ id: string }>
  /** Run one poll cycle deterministically (tests). `now` defaults to Date.now(). */
  tick(now?: number): Promise<void>
}

export type JobContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  email: EmailFacade
  storage: StorageFacade
  jobs: JobsRuntimeFacade
}

export type JobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  /** zod schema for the payload; parsed at enqueue AND before the handler runs. */
  input?: ZodType<TInput>
  /** Attempts after the first failure. Default 3 (so 4 total attempts). */
  retries?: number
  /** Delay before retry N (1-based). Default exponential: 1s, 2s, 4s, … */
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  /** Max simultaneous `running` rows of this type, enforced cross-replica. */
  concurrency?: number
  /** Lease duration in ms; an expired lease sends the job back to pending. */
  timeout?: number
  /** 5-field UTC cron expression. Cron jobs cannot declare `input`. */
  cron?: string
  handler: (
    input: TInput,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
  /** Fires once, after the final attempt fails. Errors here are logged, never retried. */
  onFailed?: (
    input: TInput,
    error: Error,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = JobDefinition<any, any, any>
export type JobsDefs = Record<string, AnyJobDefinition>

/** Throws when a definition is unusable. Safe to call more than once. */
export function validateJobsDefs(defs: JobsDefs): void {
  for (const [name, def] of Object.entries(defs)) {
    if (typeof def.handler !== 'function') {
      throw new Error(`[bunderstack] job "${name}" has no handler`)
    }
    if (def.cron !== undefined) {
      parseCron(def.cron) // throws with a clear message on invalid expressions
      if (def.input !== undefined) {
        throw new Error(
          `[bunderstack] job "${name}": cron jobs cannot declare input (nothing enqueues a payload for a schedule)`,
        )
      }
    }
    if (def.retries !== undefined && (def.retries < 0 || !Number.isInteger(def.retries))) {
      throw new Error(`[bunderstack] job "${name}": retries must be a non-negative integer`)
    }
    if (def.concurrency !== undefined && (def.concurrency < 1 || !Number.isInteger(def.concurrency))) {
      throw new Error(`[bunderstack] job "${name}": concurrency must be a positive integer`)
    }
    if (def.timeout !== undefined && def.timeout <= 0) {
      throw new Error(`[bunderstack] job "${name}": timeout must be positive`)
    }
  }
}

/** Delay in ms before retry `attempt` (1-based = the attempt that just failed). */
export function backoffMs(def: AnyJobDefinition, attempt: number): number {
  const b = def.backoff
  if (typeof b === 'function') return b(attempt)
  const baseMs = b?.baseMs ?? 1000
  const factor = b?.factor ?? 2
  return baseMs * factor ** (attempt - 1)
}

/**
 * Build the `j` instance bunderstack hands to the config's `jobs` builder
 * callback (and exports for multi-file job setups).
 */
export function createJobsBuilder<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
>() {
  return {
    /** Identity with inference: pins TInput from the zod schema. */
    job<TInput = undefined>(
      def: JobDefinition<TInput, TSchema, TEnvResult>,
    ): JobDefinition<TInput, TSchema, TEnvResult> {
      return def
    },
    /** Identity with validation: returns the defs map, typed. */
    define<TDefs extends JobsDefs>(defs: TDefs): TDefs {
      validateJobsDefs(defs)
      return defs
    },
  }
}

/** Type of the `j` instance — for builder callbacks declared in separate files. */
export type BunderstackJobsBuilder<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = ReturnType<typeof createJobsBuilder<TSchema, TEnvResult>>

type JobInputOf<TDef> = TDef extends { input: ZodType<infer I> } ? I : undefined

/** `app.jobs`: `enqueue` narrowed to declared names + payloads. */
export type JobsFacade<TDefs extends JobsDefs> = JobsRuntimeFacade & {
  enqueue<K extends keyof TDefs & string>(
    name: K,
    ...rest: JobInputOf<TDefs[K]> extends undefined
      ? [input?: undefined, opts?: EnqueueOptions]
      : [input: JobInputOf<TDefs[K]>, opts?: EnqueueOptions]
  ): Promise<{ id: string }>
}
