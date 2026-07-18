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
  /** Collapse duplicate enqueues while the queue row is non-terminal. */
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

export type QueueJobDefinition<
  TInput,
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  kind: 'job'
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
> = {
  kind: 'cron'
  schedule: string
  handler: (
    invocation: CronInvocation,
    ctx: JobContext<TSchema, TEnvResult>,
  ) => Promise<void> | void
}

export type BackgroundDefinition =
  | QueueJobDefinition<any, any, any>
  | CronDefinition<any, any>
export type BackgroundDefs = Record<string, BackgroundDefinition>

/** @deprecated Use QueueJobDefinition. */
export type JobDefinition<TInput, TSchema extends Record<string, unknown> = Record<string, unknown>, TEnvResult = Record<string, unknown>> = QueueJobDefinition<
  TInput,
  TSchema,
  TEnvResult
>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = QueueJobDefinition<any, any, any>
export type JobsDefs = BackgroundDefs

export type QueueJobKeys<TDefs extends BackgroundDefs> = {
  [K in keyof TDefs & string]: TDefs[K] extends QueueJobDefinition<any, any, any>
    ? K
    : never
}[keyof TDefs & string]

/** Throws when a definition is unusable. Safe to call more than once. */
export function validateBackgroundDefs(defs: BackgroundDefs): void {
  for (const [name, def] of Object.entries(defs)) {
    if (typeof def.handler !== 'function') {
      throw new Error(`[bunderstack] background task "${name}" has no handler`)
    }
    if (def.kind === 'cron') {
      parseCron(def.schedule)
      continue
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

/** @deprecated Use validateBackgroundDefs. */
export const validateJobsDefs = validateBackgroundDefs

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
      def: Omit<QueueJobDefinition<TInput, TSchema, TEnvResult>, 'kind'>,
    ): QueueJobDefinition<TInput, TSchema, TEnvResult> {
      return { kind: 'job', ...def }
    },
    cron(
      def: Omit<CronDefinition<TSchema, TEnvResult>, 'kind'>,
    ): CronDefinition<TSchema, TEnvResult> {
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
// `TDef extends { input: ZodType<infer I> }` fails structurally because
// `input?: ZodType<TInput>` desugars to `ZodType<TInput> | undefined`, which
// can never satisfy a required-property pattern.
type JobInputOf<TDef> = TDef extends QueueJobDefinition<infer TInput, any, any>
  ? TInput
  : undefined

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
