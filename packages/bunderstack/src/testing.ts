// src/testing.ts — test utilities for Bunderstack applications.

export { createTestApp } from './testing/fixture'
export type { TestFixture, TestOptions } from './testing/fixture'
export { mockAuthSession, TestAuthError } from './testing/auth'
export type {
  SignUpEmailInput,
  TestAuth,
  TestIdentity,
  TestUser,
} from './testing/auth'
export type { CapturedEmail, TestEmail } from './testing/email'
export type { TestStorage } from './testing/storage'
export { TestJobsConvergenceError, TestJobsError } from './testing/jobs'
export type {
  JobRunReport,
  RunNextOptions,
  RunUntilIdleOptions,
  TestJobs,
} from './testing/jobs'
export type {
  TestDatabaseStrategy,
  TestDatabaseTarget,
  TestDatabaseTargetOptions,
} from './database/adapter'
