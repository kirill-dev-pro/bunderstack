// src/jobs/index.ts — module surface consumed by createBunderstack.
export {
  createJobsBuilder,
  validateBackgroundDefs,
  validateJobsDefs,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from './define'
export type {
  AnyJobDefinition,
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
  WorkerHandle,
} from './runtime'
export { parseCron, cronMatches } from './cron'
export { slotsDue, floorSlot, CRON_PREFIX, SLOT_MS } from './slots'
export type { CatchUp } from './slots'
export type { TickResult } from './define'
