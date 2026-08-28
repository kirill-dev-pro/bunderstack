// src/testing.ts — test utilities for Bunderstack applications.

export { configureTestApp, createTestApp } from './testing/fixture'
export type {
  ConfiguredTestFixture,
  TestCleanup,
  TestConfigureOptions,
  TestFactory,
  TestFixture,
  TestMethod,
  TestOptions,
  TestSetup,
} from './testing/fixture'
export { mockAuthSession, TestAuthError } from './testing/auth'
export type {
  SignInEmailInput,
  SignUpEmailInput,
  TestAuth,
  TestIdentity,
  TestSession,
  TestUser,
} from './testing/auth'
export type { CapturedEmail, TestEmail } from './testing/email'
export type { TestStorage } from './testing/storage'
export type { TestLogEntry, TestLogMode, TestLogs } from './testing/logs'
export { TestJobsConvergenceError, TestJobsError } from './testing/jobs'
export type {
  JobRunReport,
  RunNextOptions,
  RunUntilIdleOptions,
  TestJob,
  TestJobFilter,
  TestJobs,
} from './testing/jobs'
export type {
  TestDatabaseStrategy,
  TestDatabaseTarget,
  TestDatabaseTargetOptions,
} from './database/adapter'
