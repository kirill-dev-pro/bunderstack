// src/jobs/index.ts — module surface consumed by bunderstack.
export {
  createJobsBuilder,
  validateBackgroundDefs,
  validateJobsDefs,
  DEFAULT_RETRIES,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_TIMEOUT_MS,
  leaseDurationFor,
} from './define'
export type {
  AnyJobDefinition,
  BackgroundTiming,
  BackgroundDefinition,
  BackgroundDefs,
  BunderstackJobContext,
  BunderstackJobsBuilder,
  EnqueueOptions,
  JobContext,
  JobDefinition,
  QueueJobDefinition,
  CronDefinition,
  CronInvocation,
  QueueJobKeys,
  JobsDefs,
  JobsFacade,
  JobsRuntimeFacade,
} from './define'
export { enqueueJob } from './queue'
export { createJobRunner } from './worker'
export { startJobWorker } from './runtime'
export type {
  StartWorkerOptions,
  RunWorkerOptions,
  WorkerCycleResult,
  WorkerHandle,
} from './runtime'
export { parseCron, cronMatches } from './cron'
export { slotsDue, floorSlot, CRON_PREFIX, SLOT_MS } from './slots'
export type { CatchUp } from './slots'
export type { TickResult } from './define'
