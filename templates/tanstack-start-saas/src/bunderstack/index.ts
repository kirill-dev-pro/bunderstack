import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'

import { access } from './access'
import { api, requestTiming } from './api'
import { authConfig } from './auth'
import { envSchema } from './env'
import { defineJobs } from './jobs'
import * as schema from './schema'

/**
 * Factory form so tests can own an isolated in-memory database. Production
 * uses the module-level `app` below.
 */
export async function createBunderSaaSApp(
  options: { databaseUrl?: string } = {},
) {
  return createBunderstack({
    schema,
    access,
    env: envSchema,
    database: {
      adapter: libsql(),
      url: options.databaseUrl ?? process.env.DATABASE_URL ?? 'file:./data.db',
    },
    auth: authConfig,
    email: {
      from: process.env.EMAIL_FROM ?? 'BunderSaaS <hello@example.com>',
    },
    storage: {
      local: './uploads',
      defaultBucket: 'project-files',
      buckets: {
        'project-files': {
          visibility: 'private',
          access: { create: 'authenticated', get: 'owner', delete: 'owner' },
          upload: { maxSize: '10mb' },
        },
      },
    },
    // A shared Redis transport is required once the worker runs as its own
    // process, because the in-memory broker cannot cross process boundaries.
    realtime: process.env.REDIS_URL ? { redis: process.env.REDIS_URL } : true,
    jobs: defineJobs,
    middleware: [requestTiming],
    api,
  })
}

export const createRelayApp = createBunderSaaSApp
export const app = await createBunderSaaSApp()
export const { db, auth, env } = app
export type App = typeof app

// Development pushes the schema until `migrations/` is committed, after which
// this applies the committed migrations instead.
await provision(app)
