// The app that scripts/workers-integration.ts runs on celld and workerd. It
// uses each Worker-facing feature once: auth, CRUD, a job, a cron, realtime,
// file upload, and rate limiting.
import { bunderstack } from 'bunderstack'
import { defineAccess } from 'bunderstack/access'
import { libsql } from 'bunderstack/libsql'
import * as v from 'valibot'

import * as schema from './schema'

export const backend = bunderstack({
  schema,
  access: defineAccess(schema, {
    notes: {
      crud: true,
      list: 'authenticated',
      get: 'authenticated',
      create: 'authenticated',
      update: 'authenticated',
      delete: 'authenticated',
    },
    events: {
      crud: true,
      list: 'public',
      get: 'public',
      create: 'deny',
      update: 'deny',
      delete: 'deny',
    },
  }),
  database: { adapter: libsql() },
  auth: ({ env }) => ({
    baseURL: env.APP_URL,
    emailAndPassword: { enabled: true },
    advanced: { database: { generateId: () => false } },
  }),
  env: {
    server: { APP_URL: v.optional(v.string(), 'http://127.0.0.1:8787') },
  },
  storage: {
    local: true,
    defaultBucket: 'media',
    buckets: { media: { upload: { maxSize: '1mb' } } },
  },
  realtime: true,
  rateLimit: { windowMs: 60_000, max: 1_000 },
  jobs: (j) =>
    j.define({
      noteCreated: j.job({
        input: v.object({ noteId: v.string() }),
        handler: async (input, ctx) => {
          await ctx.db
            .insert(schema.events)
            .values({ kind: 'job', detail: input.noteId })
        },
      }),
      everyMinute: j.cron({
        schedule: '* * * * *',
        handler: async ({ scheduledFor }, ctx) => {
          await ctx.db
            .insert(schema.events)
            .values({ kind: 'cron', detail: scheduledFor.toISOString() })
        },
      }),
    }),
  api: (o) => ({
    enqueueNote: o.public
      .route({ method: 'POST', path: '/api/probe/enqueue' })
      .input(v.object({ noteId: v.string() }))
      .handler(async ({ input, context }) =>
        context.jobs.enqueue('noteCreated', { noteId: input.noteId }),
      ),
  }),
})
