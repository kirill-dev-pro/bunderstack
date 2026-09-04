import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BunderstackBackend } from '../backend'
import type { AnyBunderstackApp, BunderstackClient } from '../client/rpc-client'
import type { TestDatabaseStrategy } from '../database/adapter'
import type { TestSchemaMode } from '../provision'
import type { TestAuth, TestIdentity } from './auth'
import type { TestLogs, TestLogMode } from './logs'
import type { TestMessagingForApp } from './messaging'
import type { TestStorage } from './storage'

import {
  BACKEND_INTERNALS,
  type RuntimeTestingHandle,
} from '../backend-internals'
import { provisionForTest } from '../provision'
import { createTestAuth, createTestSessionRegistry } from './auth'
import { testClient } from './client'
import { createTestDatabaseTarget } from './database'
import { createTestJobs, type TestJobs } from './jobs'
import { createTestLogs } from './logs'
import { createTestMessaging } from './messaging'
import { createTestStorage, resolveTestBuckets } from './storage'

export type TestOptions = {
  env?: Record<string, string | undefined>
  database?: {
    mode?: 'memory' | 'temporary'
    schema?: TestSchemaMode
    strategy?: TestDatabaseStrategy
  }
  logs?: TestLogMode
}

export type TestCleanup = () => unknown | Promise<unknown>

export type TestSetup<TApp, TContext> = (
  fixture: TestFixture<TApp>,
) => TContext | Promise<TContext>

export type TestConfigureOptions<TApp, TContext> = TestOptions & {
  setup?: TestSetup<TApp, TContext>
}

export type TestFixture<TApp> = AsyncDisposable & {
  readonly app: TApp
  readonly auth: TestAuth
  readonly messaging: TestMessagingForApp<TApp>
  readonly jobs: TestJobs
  readonly logs: TestLogs
  readonly storage: TestStorage
  defer(cleanup: TestCleanup): void
  client(
    identity?: TestIdentity,
  ): TApp extends AnyBunderstackApp ? BunderstackClient<TApp> : never
  close(): Promise<void>
}

export type ConfiguredTestFixture<TApp, TContext> = TestFixture<TApp> & {
  readonly context: TContext
}

export type TestFactory<TApp, TContext> = (
  options?: TestOptions,
) => Promise<ConfiguredTestFixture<TApp, TContext>>

export type TestMethod<TApp> = {
  (options?: TestOptions): Promise<TestFixture<TApp>>
  configure<TContext = undefined>(
    options: TestConfigureOptions<TApp, TContext>,
  ): TestFactory<TApp, TContext>
}

type TestableApp = {
  auth: unknown
  handler(request: Request): Promise<Response>
  close(): Promise<void>
}

const defaultTestEnv = {
  NODE_ENV: 'test',
  AUTH_SECRET: 'bunderstack-test-secret',
  BUNDERSTACK_ROLE: 'web',
} satisfies Record<string, string | undefined>

function mergeTestOptions(
  defaults: TestOptions,
  overrides: TestOptions,
): TestOptions {
  return {
    ...defaults,
    ...overrides,
    env:
      defaults.env || overrides.env
        ? { ...defaults.env, ...overrides.env }
        : undefined,
    database:
      defaults.database || overrides.database
        ? { ...defaults.database, ...overrides.database }
        : undefined,
  }
}

export function configureTestApp<
  TApp extends TestableApp,
  TContext = undefined,
>(
  backend: BunderstackBackend<TApp>,
  options: TestConfigureOptions<TApp, TContext>,
): TestFactory<TApp, TContext> {
  const { setup, ...defaults } = options
  return async (overrides = {}) => {
    const fixture = await createTestApp(
      backend,
      mergeTestOptions(defaults, overrides),
    )
    try {
      const context = setup ? await setup(fixture) : (undefined as TContext)
      return Object.assign(fixture, { context })
    } catch (cause) {
      try {
        await fixture.close()
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          '[bunderstack] test fixture setup and cleanup failed',
        )
      }
      throw cause
    }
  }
}

export async function createTestApp<TApp extends TestableApp>(
  backend: BunderstackBackend<TApp>,
  options: TestOptions = {},
): Promise<TestFixture<TApp>> {
  const internals = backend[BACKEND_INTERNALS]
  const source = { ...defaultTestEnv, ...options.env }
  const inspected = internals.inspect(source)
  const storageRoot = await mkdtemp(join(tmpdir(), 'bunderstack-storage-'))
  const resolvedStorage = resolveTestBuckets(
    inspected.config.storage,
    storageRoot,
  )
  const testMessaging = createTestMessaging(inspected.config.messaging)
  const storage = createTestStorage(resolvedStorage)
  const sessions = createTestSessionRegistry()
  const { logger, logs } = createTestLogs(options.logs)

  let target
  try {
    target = await createTestDatabaseTarget(inspected.config.database.adapter, {
      mode: options.database?.mode ?? 'memory',
      strategy: options.database?.strategy,
    })
  } catch (cause) {
    await rm(storageRoot, { recursive: true, force: true })
    throw cause
  }

  let app: TApp | undefined
  let testingHandle: RuntimeTestingHandle | undefined
  try {
    app = await internals.start(
      source,
      {
        database: target.connection,
        resolvedStorage,
        messagingAdapters: testMessaging.adapters,
        authResolver: sessions.resolver,
        logger,
        forceMemoryRealtime: true,
        backgroundAutoStart: false,
        captureTestingHandle: (handle) => {
          testingHandle = handle
        },
      },
      inspected,
    )
    await provisionForTest(app as object, options.database?.schema ?? 'auto')
  } catch (cause) {
    const cleanupErrors: unknown[] = []
    if (app) {
      try {
        await app.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await target[Symbol.asyncDispose]()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await rm(storageRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupErrors],
        '[bunderstack] test fixture setup and cleanup failed',
      )
    }
    throw cause
  }

  if (!testingHandle) {
    await app.close()
    await target[Symbol.asyncDispose]()
    await rm(storageRoot, { recursive: true, force: true })
    throw new Error('[bunderstack] runtime did not provide test controls')
  }

  const auth = createTestAuth(app, testMessaging.authEmail, sessions)
  const jobs = createTestJobs(testingHandle)
  const deferred: TestCleanup[] = []
  let closePromise: Promise<void> | undefined
  const defer = (cleanup: TestCleanup) => {
    if (closePromise) {
      throw new Error('[bunderstack] cannot defer cleanup after fixture close')
    }
    deferred.push(cleanup)
  }
  const close = () => {
    closePromise ??= (async () => {
      const errors: unknown[] = []
      for (const cleanup of deferred.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await app.close()
      } catch (error) {
        errors.push(error)
      }
      try {
        await target[Symbol.asyncDispose]()
      } catch (error) {
        errors.push(error)
      }
      try {
        await rm(storageRoot, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, '[bunderstack] fixture cleanup failed')
      }
    })()
    return closePromise
  }

  return {
    app,
    auth,
    messaging: testMessaging.messaging as TestMessagingForApp<TApp>,
    jobs,
    logs,
    storage,
    defer,
    client: (identity) => testClient(app as never, identity) as never,
    close,
    [Symbol.asyncDispose]: close,
  }
}
