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
    // Newsletters and announcements. A separate channel lets the host give it
    // its own sender, e.g. news@news.your-domain, so complaints about
    // marketing never touch the domain sign-in mail comes from.
    news: email(),
  }),
  // People to write to, signed up or not. Anything can add one:
  // `ctx.contacts.upsert()` in a procedure or job (see `subscribeToNews`),
  // the newsletter form on the landing page (captured below), a CSV import or
  // an agent on Bunderhost. One step, no confirmation email: build a double
  // opt-in yourself if you need one. Every broadcast carries a one-click
  // unsubscribe link.
  contacts: {
    capture: { source: 'landing', tags: ['newsletter'], consent: true },
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
  realtime: true,
  jobs: defineJobs,
  middleware: [requestTiming],
  api,
})
