// src/jobs/define.ts — job definition types and the typed builder.
// `createJobsBuilder` exists purely to carry
// TSchema/TEnvResult typing into inline callbacks and extracted files.
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { DbFor } from '../db'
import type { EmailFacade } from '../email'
import type { StorageFacade } from '../index'

import { parseCron } from './cron'
import { CRON_PREFIX, type CatchUp } from './slots'

export const DEFAULT_RETRIES = 3
export const DEFAULT_TIMEOUT_MS = 60_000

export type EnqueueOptions = {
  /** Collapse duplicate enqueues while the queue row is non-terminal. */
  dedupeKey?: string
  /** Milliseconds from now until the job becomes claimable. */
  delay?: number
  /** Absolute time the job becomes claimable; wins over `delay`. */
  runAt?: Date | number
}

export type TickResult = {
  /** Rows moved from pending to running this tick. */
  claimed: number
  /** Handlers that completed successfully. */
  ran: number
  /** Handlers that threw, whether or not they will be retried. */
  failed: number
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
  tick(now?: number): Promise<TickResult>
}

import type { RealtimeFacade } from '../realtime/facade'

export type JobContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  email: EmailFacade
  storage: StorageFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
}

export type BunderstackJobContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = JobContext<TSchema, TEnvResult>

export type QueueJobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  kind: 'job'
  /** Standard Schema payload; parsed at enqueue AND before the handler runs. */
  input?: StandardSchemaV1<unknown, TInput>
  /** Attempts after the first failure. Default 3 (so 4 total attempts). */
  retries?: number
  /** Delay before retry N (1-based). Default exponential: 1s, 2s, 4s, … */
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  /** Max simultaneous `running` rows of this type, enforced per worker. */
  concurrency?: number
  /** Lease duration in ms; an expired lease sends the job back to pending. */
  timeout?: number
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

export type CronInvocation = { scheduledFor: Date }

export type CronDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TSchedule extends string = string,
> = {
  kind: 'cron'
  schedule: TSchedule
  /** Attempts after the first failure. Default 3 (so 4 total attempts). */
  retries?: number
  /** Delay before retry N (1-based). Default exponential: 1s, 2s, 4s, … */
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  /** Lease duration in ms; an expired lease sends the slot back to pending. */
  timeout?: number
  /** How missed slots are handled on wake. Default 'latest'. */
  catchUp?: CatchUp
  /** How far back catch-up looks, in ms. Default 1 hour. */
  catchUpWindow?: number
  handler: (
    invocation: CronInvocation,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
  /** Fires once, after the final attempt fails. Errors here are logged, never retried. */
  onFailed?: (
    invocation: CronInvocation,
    error: Error,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
}

export type BackgroundDefinition =
  | QueueJobDefinition<any, any, any>
  | CronDefinition<any, any>
export type BackgroundDefs = Record<string, BackgroundDefinition>

/** @deprecated Use QueueJobDefinition. */
export type JobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = QueueJobDefinition<TInput, TSchema, TEnvResult>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = QueueJobDefinition<any, any, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBackgroundDefinition =
  | QueueJobDefinition<any, any, any>
  | CronDefinition<any, any, any>
export type JobsDefs = BackgroundDefs

export type QueueJobKeys<TDefs extends BackgroundDefs> = {
  [K in keyof TDefs & string]: TDefs[K] extends QueueJobDefinition<
    any,
    any,
    any
  >
    ? K
    : never
}[keyof TDefs & string]

/** Throws when a definition is unusable. Safe to call more than once. */
export function validateBackgroundDefs(defs: BackgroundDefs): void {
  for (const [name, def] of Object.entries(defs)) {
    if (typeof def.handler !== 'function') {
      throw new Error(`[bunderstack] background task "${name}" has no handler`)
    }
    if (def.kind === 'job' && name.startsWith(CRON_PREFIX)) {
      throw new Error(
        `[bunderstack] job "${name}": the "${CRON_PREFIX}" prefix is reserved for cron tasks`,
      )
    }
    if (
      def.retries !== undefined &&
      (def.retries < 0 || !Number.isInteger(def.retries))
    ) {
      throw new Error(
        `[bunderstack] background task "${name}": retries must be a non-negative integer`,
      )
    }
    if (def.timeout !== undefined && def.timeout <= 0) {
      throw new Error(
        `[bunderstack] background task "${name}": timeout must be positive`,
      )
    }
    if (def.kind === 'cron') {
      parseCron(def.schedule)
      if ((def as { concurrency?: number }).concurrency !== undefined) {
        throw new Error(
          `[bunderstack] cron "${name}": concurrency is not supported for cron tasks — slots are already unique`,
        )
      }
      if (def.catchUpWindow !== undefined && def.catchUpWindow <= 0) {
        throw new Error(
          `[bunderstack] cron "${name}": catchUpWindow must be positive`,
        )
      }
      continue
    }
    if (
      def.concurrency !== undefined &&
      (def.concurrency < 1 || !Number.isInteger(def.concurrency))
    ) {
      throw new Error(
        `[bunderstack] job "${name}": concurrency must be a positive integer`,
      )
    }
  }
}

/** @deprecated Use validateBackgroundDefs. */
export const validateJobsDefs = validateBackgroundDefs

/**
 * Delay in ms before retry `attempt` (1-based = the attempt that just failed).
 * Jittered by ±20% so a shared outage does not retry every job in lockstep.
 * A caller-supplied backoff function is returned verbatim — the caller owns it.
 */
export function backoffMs(
  def: AnyBackgroundDefinition,
  attempt: number,
): number {
  const b = def.backoff
  if (typeof b === 'function') return b(attempt)
  const baseMs = b?.baseMs ?? 1000
  const factor = b?.factor ?? 2
  const flat = baseMs * factor ** (attempt - 1)
  return Math.round(flat * (0.8 + Math.random() * 0.4))
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
    /** Identity with inference: pins TInput from the schema output. */
    job<TInput = undefined>(
      def: Omit<QueueJobDefinition<TInput, TSchema, TEnvResult>, 'kind'>,
    ): QueueJobDefinition<TInput, TSchema, TEnvResult> {
      return { kind: 'job', ...def }
    },
    cron<const TSchedule extends string>(
      def: Omit<CronDefinition<TSchema, TEnvResult, TSchedule>, 'kind'>,
    ): CronDefinition<TSchema, TEnvResult, TSchedule> {
      parseCron(def.schedule)
      return { kind: 'cron', ...def }
    },
    /** Identity with validation: returns the defs map, typed. */
    define<TDefs extends BackgroundDefs>(defs: TDefs): TDefs {
      validateBackgroundDefs(defs)
      return defs
    },
  }
}

/** Type of the `j` instance — for builder callbacks declared in separate files. */
export type BunderstackJobsBuilder<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = ReturnType<typeof createJobsBuilder<TSchema, TEnvResult>>

// Infers TInput from the JobDefinition's own type argument rather than
// pattern-matching the (optional, so union-with-undefined) `input` property —
// A required-property pattern fails structurally because `input` is optional,
// so infer from the definition's own type argument instead.
type JobInputOf<TDef> =
  TDef extends QueueJobDefinition<infer TInput, any, any> ? TInput : undefined

/**
 * `app.jobs`: `enqueue` narrowed to declared names + payloads. `Omit`s the
 * runtime facade's loose `enqueue` first — intersecting two same-named
 * methods instead would make TS treat them as overloaded, so the loose
 * `(name: string, ...)` signature would still accept any name.
 */
export type JobsFacade<TDefs extends JobsDefs> = Omit<
  JobsRuntimeFacade,
  'enqueue'
> & {
  enqueue<K extends QueueJobKeys<TDefs>>(
    name: K,
    ...rest: JobInputOf<TDefs[K]> extends undefined
      ? [input?: undefined, opts?: EnqueueOptions]
      : [input: JobInputOf<TDefs[K]>, opts?: EnqueueOptions]
  ): Promise<{ id: string }>
}
