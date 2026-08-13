import { anonymous } from 'better-auth/plugins'
/**
 * bunderstack.ts — app entry point, showcasing every feature:
 *
 *   0. Shareable boards          → capability URLs (see access.ts)
 *   1. Auto-CRUD + access rules  → `schema` + `access` keys
 *   2. Env validation            → `env` key + `app.env`
 *   3. Email sending             → `email` key + `app.email`
 *   4. Unified oRPC endpoints    → `defineApi` bases + `api` client
 *   4b. Graph-wide middleware    → `middleware` key, covers generated CRUD
 *   5. File storage + transforms → `storage` key + `api.files`
 *   6. Realtime SSE              → `realtime: true`, broadcast-on-write
 *   7. Background jobs + cron    → `jobs` key + `app.jobs`
 */
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'
import { asTypeId } from 'bunderstack/typeid'
import { and, desc, eq, lt } from 'drizzle-orm'
import * as v from 'valibot'

import { access } from './access'
import { api, requestLog } from './api'
import { envSchema } from './env'
import * as schema from './schema'

/** Demo-tuned retention for the archive cron — short so the effect is
 *  visible in a live demo. A real app would use something like 30 days. */
const ARCHIVE_DONE_TODOS_AFTER_MS = 2 * 60_000

export const app = await createBunderstack({
  schema,
  access,

  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },

  // Username-only auth: the anonymous plugin creates a real session
  // without passwords or signup. See routes/index.tsx for the client side.
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3005',
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    plugins: [anonymous()],
    advanced: {
      database: { generateId: () => false },
    },
  },

  // Env validation: all vars checked at boot, `app.env` fully typed.
  env: envSchema,

  // Email: 'console' provider by default in dev (logs to stdout).
  // Set SMTP_URL in .env for real delivery.
  email: {
    from: 'todo@example.com',
  },

  // File storage: local disk in dev (./uploads), S3 in production.
  // `transforms: true` enables on-the-fly sharp resizing via ?w=&h=&format=.
  storage: {
    local: true,
    buckets: {
      images: {
        upload: { maxSize: '5mb', accept: ['image/*'] },
        transforms: true,
      },
    },
  },

  // Realtime: SSE endpoint + broadcast-on-write for every CRUD change.
  // The client consumes the typed Publisher iterator (see router.tsx).
  realtime: true,

  // Background work is declarative. Queue jobs run in an explicit worker
  // process; production cron is delivered by Bunderhost over signed HTTP.
  jobs: (j) =>
    j.define({
      celebrateBoardComplete: j.job({
        input: v.object({ boardId: v.string() }),
        retries: 3,
        handler: async (input, ctx) => {
          const boardId = asTypeId('board', input.boardId)
          const board = await ctx.db
            .select()
            .from(schema.boards)
            .where(eq(schema.boards.id, boardId))
            .get()
          if (!board) return

          const owner = await ctx.db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, board.ownerId))
            .get()
          if (!owner) return

          await ctx.email.send({
            to: owner.email,
            subject: `🎉 Board complete: ${board.name}`,
            text: `Hi ${owner.name},\n\nEvery todo on "${board.name}" is done!\n\n— ${ctx.env.PUBLIC_APP_NAME}`,
          })
        },
      }),

      archiveDoneTodos: j.cron({
        schedule: '* * * * *',
        handler: async ({ scheduledFor }, ctx) => {
          const cutoff = new Date(
            scheduledFor.getTime() - ARCHIVE_DONE_TODOS_AFTER_MS,
          )
          await ctx.db
            .delete(schema.todos)
            .where(
              and(
                eq(schema.todos.done, true),
                lt(schema.todos.completedAt, cutoff),
              ),
            )
        },
      }),
    }),

  // Applies to every procedure, generated ones included.
  middleware: [requestLog],

  // oRPC custom procedures mounted alongside CRUD, declared in api.ts
  api,
})

/** Type handle for client inference — no server code in the bundle. */
export type App = typeof app

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)
