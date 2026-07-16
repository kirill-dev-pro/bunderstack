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
 */
import { createBunderstack } from 'bunderstack'
import { provision } from 'bunderstack/provision'
import { asTypeId } from 'bunderstack/typeid'
import { anonymous } from 'better-auth/plugins'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { access } from './access'
import * as schema from './schema'

export const app = await createBunderstack({
  schema,
  access,

  database: { url: process.env.DATABASE_URL ?? 'file:./data.db' },

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
            .values({ name: input.name, ownerId: asTypeId('user', ctx.user.id) })
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

          return { ok: true }
        }),
    }),
})

/** Type handle for client inference — no server code in the bundle. */
export type App = typeof app

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)
