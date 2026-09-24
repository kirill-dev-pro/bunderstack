// src/jobs/define.ts — job definition types and the typed builder.
// `createJobsBuilder` exists purely to carry
// TSchema/TEnvResult typing into inline callbacks and extracted files.
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { BunderstackTx, DbFor } from '../db'
import type { AnyDb } from '../dialect'
import type { MessagingConfig, MessagingFacadesFor } from '../messaging'
import type { StorageFacade } from '../runtime'

import { parseCron } from './cron'
import { CRON_PREFIX, type CatchUp } from './slots'

export const DEFAULT_RETRIES = 3
export const DEFAULT_LEASE_DURATION_MS = 60_000
/** @deprecated Use DEFAULT_LEASE_DURATION_MS. */
export const DEFAULT_TIMEOUT_MS = DEFAULT_LEASE_DURATION_MS

export type BackgroundTiming = {
  /** Lease duration in ms; an expired lease sends the job back to pending. */
  leaseDuration?: number
  /** Optional cooperative execution deadline in ms. */
  maxRuntime?: number
  /** @deprecated Use leaseDuration. */
  timeout?: number
}

export function leaseDurationFor<T extends BackgroundTiming>(def: T): number {
  return def.leaseDuration ?? def.timeout ?? DEFAULT_LEASE_DURATION_MS
}

/**
 * Structural view of a Drizzle database or transaction handle that `enqueue`
 * can insert through. The loose runtime facade accepts any handle of the app's
 * dialect; `app.jobs` narrows it to the app's `BunderstackTx`.
 */
export type EnqueueTransaction = AnyDb

export type EnqueueOptions = {
  /**
   * Collapse duplicate enqueues while the queue row holds its key: until a
   * terminal state by default, or until it is claimed with
   * `dedupeUntil: 'start'`.
   */
  dedupeKey?: string
  /** Milliseconds from now until the job becomes claimable. */
  delay?: number
  /** Absolute time the job becomes claimable; wins over `delay`. */
  runAt?: Date | number
  /**
   * Insert the job row through this transaction. The job becomes visible to
   * workers only when the transaction commits; a rollback removes it. Must be
   * a transaction on the app's own database.
   */
  tx?: EnqueueTransaction
}

/** `EnqueueOptions` with `tx` narrowed to the app schema's transaction type. */
export type TypedEnqueueOptions<TSchema extends Record<string, unknown>> = Omit<
  EnqueueOptions,
  'tx'
> & {
  /**
   * Insert the job row through this transaction. The job becomes visible to
   * workers only when the transaction commits; a rollback removes it.
   */
  tx?: BunderstackTx<TSchema>
}

/**
 * How long a queue job's `dedupeKey` collapses new enqueues.
 * - `'finish'` (default): until the job reaches a terminal state.
 * - `'start'`: until a worker claims the job; later enqueues create a new row
 *   that runs after it and reads the newer state.
 */
export type DedupeUntil = 'start' | 'finish'

export type TickResult = {
  /** Rows moved from pending to running this tick. */
  claimed: number
  /** Handlers that completed successfully. */
  ran: number
  /** Handlers that threw, whether or not they will be retried. */
  failed: number
}

/**
 * The untyped runtime facade. Job handlers and API context expose this shape;
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
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  messaging: MessagingFacadesFor<TMessaging>
  storage: StorageFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  /** Aborted when execution reaches its deadline or the job loses its lease. */
  signal: AbortSignal
}

export type BunderstackJobContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = JobContext<TSchema, TEnvResult, TMessaging>

export type QueueJobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = BackgroundTiming & {
  kind: 'job'
  /** Standard Schema payload; parsed at enqueue AND before the handler runs. */
  input?: StandardSchemaV1<unknown, TInput>
  /** Attempts after the first failure. Default 3 (so 4 total attempts). */
  retries?: number
  /** Delay before retry N (1-based). Default exponential: 1s, 2s, 4s, … */
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  /** Max simultaneous `running` rows of this type, enforced per worker. */
  concurrency?: number
  /**
   * When a `dedupeKey` stops collapsing new enqueues. Default `'finish'`:
   * held until a terminal state. `'start'`: released when a worker claims the
   * job, so an enqueue during the run schedules one more run.
   */
  dedupeUntil?: DedupeUntil
  handler: (
    input: TInput,
    ctx: JobContext<TSchema, TEnvResult, TMessaging>,
  ) => Promise<void> | void
  /** Fires once, after the final attempt fails. Errors here are logged, never retried. */
  onFailed?: (
    input: TInput,
    error: Error,
    ctx: JobContext<TSchema, TEnvResult, TMessaging>,
  ) => Promise<void> | void
}

export type CronInvocation = { scheduledFor: Date }

export type CronDefinition<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TSchedule extends string = string,
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = BackgroundTiming & {
  kind: 'cron'
  schedule: TSchedule
  /** Attempts after the first failure. Default 3 (so 4 total attempts). */
  retries?: number
  /** Delay before retry N (1-based). Default exponential: 1s, 2s, 4s, … */
  backoff?: ((attempt: number) => number) | { baseMs?: number; factor?: number }
  /** How missed slots are handled on wake. Default 'latest'. */
  catchUp?: CatchUp
  /** How far back catch-up looks, in ms. Default 1 hour. */
  catchUpWindow?: number
  handler: (
    invocation: CronInvocation,
    ctx: JobContext<TSchema, TEnvResult, TMessaging>,
  ) => Promise<void> | void
  /** Fires once, after the final attempt fails. Errors here are logged, never retried. */
  onFailed?: (
    invocation: CronInvocation,
    error: Error,
    ctx: JobContext<TSchema, TEnvResult, TMessaging>,
  ) => Promise<void> | void
}

export type BackgroundDefinition =
  | QueueJobDefinition<any, any, any, any>
  | CronDefinition<any, any, any, any>
export type BackgroundDefs = Record<string, BackgroundDefinition>

/** @deprecated Use QueueJobDefinition. */
export type JobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = QueueJobDefinition<TInput, TSchema, TEnvResult, TMessaging>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = QueueJobDefinition<any, any, any, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBackgroundDefinition =
  | QueueJobDefinition<any, any, any, any>
  | CronDefinition<any, any, any, any>
export type JobsDefs = BackgroundDefs

export type QueueJobKeys<TDefs extends BackgroundDefs> = {
  [K in keyof TDefs & string]: TDefs[K] extends QueueJobDefinition<
    any,
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
    if (def.timeout !== undefined && def.leaseDuration !== undefined) {
      throw new Error(
        `[bunderstack] background task "${name}": timeout and leaseDuration cannot both be declared`,
      )
    }
    for (const field of ['timeout', 'leaseDuration', 'maxRuntime'] as const) {
      const value = def[field]
      if (
        value !== undefined &&
        (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
      ) {
        throw new Error(
          `[bunderstack] background task "${name}": ${field} must be a positive finite integer`,
        )
      }
    }
    if (def.kind === 'cron') {
      parseCron(def.schedule)
      assertCronHasNoDedupeUntil(def, `cron "${name}"`)
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
    if (
      def.dedupeUntil !== undefined &&
      def.dedupeUntil !== 'start' &&
      def.dedupeUntil !== 'finish'
    ) {
      throw new Error(
        `[bunderstack] job "${name}": dedupeUntil must be 'start' or 'finish'`,
      )
    }
  }
}

/** Cron slot ownership depends on the retained dedupe key. */
function assertCronHasNoDedupeUntil(def: object, label: string): void {
  if ((def as { dedupeUntil?: unknown }).dedupeUntil !== undefined) {
    throw new Error(
      `[bunderstack] ${label}: dedupeUntil is not supported for cron tasks — cron tasks retain their slot key`,
    )
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
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
>() {
  return {
    /** Identity with inference: pins TInput from the schema output. */
    job<TInput = undefined>(
      def: Omit<
        QueueJobDefinition<TInput, TSchema, TEnvResult, TMessaging>,
        'kind'
      >,
    ): QueueJobDefinition<TInput, TSchema, TEnvResult, TMessaging> {
      return { kind: 'job', ...def }
    },
    cron<const TSchedule extends string>(
      def: Omit<
        CronDefinition<TSchema, TEnvResult, TSchedule, TMessaging>,
        'kind'
      >,
    ): CronDefinition<TSchema, TEnvResult, TSchedule, TMessaging> {
      parseCron(def.schedule)
      assertCronHasNoDedupeUntil(def, 'cron')
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
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = ReturnType<typeof createJobsBuilder<TSchema, TEnvResult, TMessaging>>

// Infers TInput from the JobDefinition's own type argument rather than
// pattern-matching the (optional, so union-with-undefined) `input` property —
// A required-property pattern fails structurally because `input` is optional,
// so infer from the definition's own type argument instead.
type JobInputOf<TDef> =
  TDef extends QueueJobDefinition<infer TInput, any, any, any>
    ? TInput
    : undefined

/**
 * `app.jobs`: `enqueue` narrowed to declared names + payloads. `Omit`s the
 * runtime facade's loose `enqueue` first — intersecting two same-named
 * methods instead would make TS treat them as overloaded, so the loose
 * `(name: string, ...)` signature would still accept any name.
 */
export type JobsFacade<
  TDefs extends JobsDefs,
  TSchema extends Record<string, unknown> | undefined = undefined,
> = Omit<JobsRuntimeFacade, 'enqueue'> & {
  enqueue<K extends QueueJobKeys<TDefs>>(
    name: K,
    ...rest: JobInputOf<TDefs[K]> extends undefined
      ? [input?: undefined, opts?: JobsFacadeEnqueueOptions<TSchema>]
      : [input: JobInputOf<TDefs[K]>, opts?: JobsFacadeEnqueueOptions<TSchema>]
  ): Promise<{ id: string }>
}

type JobsFacadeEnqueueOptions<
  TSchema extends Record<string, unknown> | undefined,
> = [TSchema] extends [Record<string, unknown>]
  ? TypedEnqueueOptions<TSchema>
  : EnqueueOptions
