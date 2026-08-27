import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'

import { access } from './access'
import { api, requestTiming } from './api'
import { authConfig } from './auth'
import { envSchema } from './env'
import { defineJobs } from './jobs'
import * as schema from './schema'

/**
 * The application declaration is synchronous and side-effect free. Blueprint
 * generation imports this module without opening a database or starting jobs.
 */
export const backend = bunderstack({
  schema,
  access,
  env: envSchema,
  database: { adapter: libsql() },
  auth: authConfig,
  email: { from: 'BunderSaaS <hello@example.com>' },
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
  realtime: true,
  jobs: defineJobs,
  middleware: [requestTiming],
  api,
})
