import type {
  RuntimeJobFailure,
  RuntimeTestingHandle,
} from '../backend-internals'

export type JobRunReport = {
  ticks: number
  claimed: number
  ran: number
  failed: number
  remainingRunnable: number
}

export type RunNextOptions = { now?: Date | number }

export type RunUntilIdleOptions = RunNextOptions & {
  maxTicks?: number
  failOnJobError?: boolean
}

export class TestJobsError extends Error {
  override readonly name = 'TestJobsError'

  constructor(
    readonly report: JobRunReport,
    readonly failures: RuntimeJobFailure[],
  ) {
    super(
      `[bunderstack] ${failures.length} background job${failures.length === 1 ? '' : 's'} failed: ${failures.map((failure) => `${failure.name}: ${failure.lastError ?? 'unknown error'}`).join('; ')}`,
    )
  }
}

export class TestJobsConvergenceError extends Error {
  override readonly name = 'TestJobsConvergenceError'

  constructor(readonly report: JobRunReport) {
    super(
      `[bunderstack] background jobs did not become idle after ${report.ticks} ticks (${report.remainingRunnable} still runnable)`,
    )
  }
}

export type TestJobs = {
  runNext(options?: RunNextOptions): Promise<JobRunReport>
  runUntilIdle(options?: RunUntilIdleOptions): Promise<JobRunReport>
}

function timestamp(value: Date | number | undefined): number {
  return value === undefined ? Date.now() : new Date(value).getTime()
}

export function createTestJobs(handle: RuntimeTestingHandle): TestJobs {
  return {
    async runNext(options = {}) {
      const now = timestamp(options.now)
      const tick = await handle.tick(now)
      const inspection = await handle.inspect(now)
      return {
        ticks: 1,
        ...tick,
        remainingRunnable: inspection.runnable,
      }
    },

    async runUntilIdle(options = {}) {
      const now = timestamp(options.now)
      const maxTicks = options.maxTicks ?? 100
      if (!Number.isInteger(maxTicks) || maxTicks <= 0) {
        throw new TypeError('[bunderstack] maxTicks must be a positive integer')
      }

      const report: JobRunReport = {
        ticks: 0,
        claimed: 0,
        ran: 0,
        failed: 0,
        remainingRunnable: 0,
      }
      let inspection: Awaited<ReturnType<RuntimeTestingHandle['inspect']>>

      do {
        const tick = await handle.tick(now)
        report.ticks++
        report.claimed += tick.claimed
        report.ran += tick.ran
        report.failed += tick.failed
        inspection = await handle.inspect(now)
        report.remainingRunnable = inspection.runnable

        if (inspection.runnable > 0 && report.ticks >= maxTicks) {
          throw new TestJobsConvergenceError(report)
        }
      } while (inspection.runnable > 0)

      if ((options.failOnJobError ?? true) && inspection.failed.length > 0) {
        throw new TestJobsError(report, inspection.failed)
      }
      return report
    },
  }
}
