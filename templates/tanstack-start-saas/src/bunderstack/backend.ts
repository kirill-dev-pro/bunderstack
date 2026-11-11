import { bunderstack, email } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'

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
  env: envSchema,
  access,
  database: { adapter: libsql() },
  auth: authConfig,
  messaging: (env) => ({
    // The host chooses the provider (hosted mail or your own Resend account)
    // and the sender; locally the channel captures to the console.
    email: email({ from: env.EMAIL_FROM }),
  }),
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
