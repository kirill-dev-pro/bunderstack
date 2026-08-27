import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BunderstackBackend } from '../backend'
import type { AnyBunderstackApp, BunderstackClient } from '../client/rpc-client'
import type { TestDatabaseStrategy } from '../database/adapter'
import type { TestSchemaMode } from '../provision'
import type { TestAuth, TestIdentity } from './auth'
import type { TestEmail } from './email'
import type { TestStorage } from './storage'

import { BACKEND_INTERNALS } from '../backend-internals'
import { provisionForTest } from '../provision'
import { createTestAuth } from './auth'
import { testClient } from './client'
import { createTestDatabaseTarget } from './database'
import { createTestEmail } from './email'
import { createTestStorage, resolveTestBuckets } from './storage'

export type TestOptions = {
  env?: Record<string, string | undefined>
  database?: {
    mode?: 'memory' | 'temporary'
    schema?: TestSchemaMode
    strategy?: TestDatabaseStrategy
  }
}

export type TestFixture<TApp> = AsyncDisposable & {
  readonly app: TApp
  readonly auth: TestAuth
  readonly email: TestEmail
  readonly storage: TestStorage
  client(
    identity?: TestIdentity,
  ): TApp extends AnyBunderstackApp ? BunderstackClient<TApp> : never
  close(): Promise<void>
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

export async function createTestApp<TApp extends TestableApp>(
  backend: BunderstackBackend<TApp>,
  options: TestOptions = {},
): Promise<TestFixture<TApp>> {
  const internals = backend[BACKEND_INTERNALS]
  const storageRoot = await mkdtemp(join(tmpdir(), 'bunderstack-storage-'))
  const resolvedStorage = resolveTestBuckets(
    internals.declaration.config.storage,
    storageRoot,
  )
  const { adapter: emailAdapter, email } = createTestEmail()
  const storage = createTestStorage(resolvedStorage)

  let target
  try {
    target = await createTestDatabaseTarget(
      internals.declaration.config.database.adapter,
      {
        mode: options.database?.mode ?? 'memory',
        strategy: options.database?.strategy,
      },
    )
  } catch (cause) {
    await rm(storageRoot, { recursive: true, force: true })
    throw cause
  }

  let app: TApp | undefined
  try {
    app = await internals.start(
      { ...defaultTestEnv, ...options.env },
      {
        database: target.connection,
        resolvedStorage,
        emailAdapter,
        forceMemoryRealtime: true,
        backgroundAutoStart: false,
      },
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

  const auth = createTestAuth(app)
  let closePromise: Promise<void> | undefined
  const close = () => {
    closePromise ??= (async () => {
      const errors: unknown[] = []
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
    email,
    storage,
    client: (identity) => testClient(app as never, identity) as never,
    close,
    [Symbol.asyncDispose]: close,
  }
}
