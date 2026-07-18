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
export { runCronSlot, runScheduledSlot } from './cron-runner'
export type { CronRunResult } from './cron-runner'
export { buildCronRouter } from './cron-router'
export { signScheduleRequest, verifyScheduleRequest } from './cron-auth'
export { startJobWorker } from './runtime'
export type { StartWorkerOptions, RunWorkerOptions, WorkerHandle } from './runtime'
export { parseCron, cronMatches } from './cron'
