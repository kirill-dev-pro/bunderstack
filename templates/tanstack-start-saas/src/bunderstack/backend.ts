import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'

import { access } from './access'
import { api, PUBLIC_BUCKET, requestTiming } from './api'
import { authConfig } from './auth'
import { envSchema } from './env'
import { defineJobs } from './jobs'
import { messaging } from './messaging'
import * as schema from './schema'

/**
 * The application declaration is synchronous and side-effect free. Blueprint
 * generation imports this module without opening a database or starting jobs.
 */
export const backend = bunderstack({
  schema,
  env: envSchema,
  access,
  // `seed` is what an empty database starts with: a demo user, two projects
  // and their tasks (see `seed.ts`). A lazy import, so a process that is not
  // asked to seed never loads it. `bun run dev` asks; production never does.
  database: { adapter: libsql(), seed: () => import('./seed') },
  auth: authConfig,
  messaging,
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
      // Anyone can read these: project covers, and images for newsletters
      // (Bunderhost's Broadcasts tab uploads them here).
      [PUBLIC_BUCKET]: {
        visibility: 'public',
        access: { create: 'authenticated', get: 'public', delete: 'owner' },
        upload: {
          accept: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
          maxSize: '5mb',
        },
      },
    },
  },
  realtime: true,
  jobs: defineJobs,
  middleware: [requestTiming],
  api,
})
