import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'

import { access } from './access'
import { authConfig } from './auth'
import { envSchema } from './env'
import { defineJobs } from './jobs'
import * as schema from './schema'
import { createAppRouter } from './trpc'

/**
 * Factory form so tests can own an isolated in-memory database. Production
 * uses the module-level `app` below.
 */
export async function createRelayApp(options: { databaseUrl?: string } = {}) {
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
      from: process.env.EMAIL_FROM ?? 'Relay <hello@example.com>',
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
    trpc: createAppRouter,
  })
}

export const app = await createRelayApp()
export const { db, auth, env } = app
export type App = typeof app

// Development pushes the schema until `migrations/` is committed, after which
// this applies the committed migrations instead.
await provision(app)
