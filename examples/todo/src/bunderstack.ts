import { anonymous } from 'better-auth/plugins'
/**
 * bunderstack.ts — app entry point, showcasing every feature:
 *
 *   0. Shareable boards          → capability URLs (see access.ts)
 *   1. Auto-CRUD + access rules  → `schema` + `access` keys
 *   2. Env validation            → `env` key + `app.env`
 *   3. Email sending             → `email` key + `app.email`
 *   4. tRPC endpoints            → `trpc` builder + `api.trpc`
 *   5. File storage + transforms → `storage` key + `api.files`
 *   6. Realtime SSE              → `realtime: true`, broadcast-on-write
 *   7. Background jobs + cron    → `jobs` key + `app.jobs`
 */
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'
import { asTypeId } from 'bunderstack/typeid'
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'

import { access } from './access'
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
  // Server vars must NOT start with PUBLIC_; client vars MUST.
  env: {
    server: {
      NOTIFY_COMPLETED: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    },
    client: {
      PUBLIC_APP_NAME: z.string().default('Todo Example'),
    },
  },

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
  // The client subscribes via createRealtimeClient (see router.tsx).
  realtime: true,

  // Background work is declarative. Queue jobs run in an explicit worker
  // process; production cron is delivered by Bunderhost over signed HTTP.
  jobs: (j) =>
    j.define({
      /** Enqueued from `trpc.complete` below once a board has no pending
       *  todos left. Offloaded (instead of sent inline like the per-todo
       *  NOTIFY_COMPLETED email) so the mutation returns immediately and
       *  a flaky email provider gets retried instead of failing the request.
       *  Deduped per board so rapidly toggling the last todo can't queue
       *  more than one celebration while one is in flight. */
      celebrateBoardComplete: j.job({
        input: z.object({ boardId: z.string() }),
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

      /** Cron: sweeps todos that have been done for a while. Bunderhost
       *  delivers the UTC schedule slot to the web process. Note: this runs a raw `ctx.db.delete`, which bypasses
       *  the CRUD router — unlike every other write in this app, it does
       *  NOT broadcast over realtime, so archived todos disappear on next
       *  reload rather than live. */
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

  // tRPC: pre-wired with superjson, protectedProcedure, and a typed
  // context carrying db, user, env, and email.
  trpc: (t) =>
    t.router({
      /** Boards owned by the current user — the home screen list.
       *  Goes through tRPC (not auto-CRUD) so boards can't be enumerated:
       *  the only way into someone else's board is its shared link. */
      myBoards: t.protectedProcedure.query(({ ctx }) =>
        ctx.db
          .select()
          .from(schema.boards)
          .where(eq(schema.boards.ownerId, asTypeId('user', ctx.user.id)))
          .orderBy(desc(schema.boards.createdAt))
          .all(),
      ),

      /** Create a board with the owner stamped server-side. */
      createBoard: t.protectedProcedure
        .input(z.object({ name: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          const [board] = await ctx.db
            .insert(schema.boards)
            .values({
              name: input.name,
              ownerId: asTypeId('user', ctx.user.id),
            })
            .returning()
          return board!
        }),

      /** Aggregate todo stats for one board. */
      stats: t.protectedProcedure
        .input(z.object({ boardId: z.string() }))
        .query(async ({ ctx, input }) => {
          const all = await ctx.db
            .select()
            .from(schema.todos)
            .where(eq(schema.todos.boardId, asTypeId('board', input.boardId)))
            .all()

          return {
            total: all.length,
            done: all.filter((t) => t.done).length,
            pending: all.filter((t) => !t.done).length,
          }
        }),

      /** Mark a todo done AND send a notification email — one atomic
       *  server call instead of update + separate email API. */
      complete: t.protectedProcedure
        .input(z.object({ id: z.string() }))
        .mutation(async ({ ctx, input }) => {
          const todo = await ctx.db
            .select()
            .from(schema.todos)
            .where(eq(schema.todos.id, asTypeId('todo', input.id)))
            .get()

          if (!todo) throw new Error('Todo not found')

          await ctx.db
            .update(schema.todos)
            .set({ done: true, completedAt: new Date() })
            .where(eq(schema.todos.id, asTypeId('todo', input.id)))

          if (ctx.env.NOTIFY_COMPLETED) {
            await ctx.email.send({
              to: ctx.user.email!,
              subject: `✅ Completed: ${todo.title}`,
              text: `Hi ${ctx.user.name},\n\nYou completed "${todo.title}".\n\n— ${ctx.env.PUBLIC_APP_NAME}`,
            })
          }

          // Jobs: if that was the last pending todo on the board, offload a
          // celebration email to the background queue instead of sending it
          // inline here (see `celebrateBoardComplete` above).
          const stillPending = await ctx.db
            .select()
            .from(schema.todos)
            .where(
              and(
                eq(schema.todos.boardId, todo.boardId),
                eq(schema.todos.done, false),
              ),
            )
            .all()
          if (stillPending.length === 0) {
            await ctx.jobs.enqueue(
              'celebrateBoardComplete',
              { boardId: todo.boardId },
              { dedupeKey: `board-complete:${todo.boardId}` },
            )
          }

          return { ok: true }
        }),
    }),
})

/** Type handle for client inference — no server code in the bundle. */
export type App = typeof app

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)
