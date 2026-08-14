import { defineApi } from 'bunderstack'
import { asTypeId } from 'bunderstack/typeid'
import { and, desc, eq } from 'drizzle-orm'
import * as v from 'valibot'

import { envSchema } from './env'
import * as schema from './schema'

// The builder is a plain module value, so this file needs no factory wrapper
// and no procedure bag passed in from the config.
const o = defineApi({ schema, env: envSchema })

/**
 * Passed to `createBunderstack({ middleware })`, which applies it to every
 * procedure in the graph — the generated CRUD and file endpoints included. The
 * same function attached to `o.protected` would only cover the procedures
 * declared below, which is the usual way observability ends up with a blind
 * spot over the busiest routes.
 */
export const requestLog = o.middleware(async ({ context, next, path }) => {
  // A realtime subscription ends when the client disconnects, so timing it
  // would measure the connection rather than any work.
  if (path[0] === 'realtime') return next()

  const startedAt = performance.now()
  try {
    return await next()
  } finally {
    // `peekSession()` reads a session someone already resolved. Calling
    // `getSession()` here would authenticate every request, including the
    // webhook below, which authenticates itself with a signature.
    console.info(
      `[rpc] ${path.join('.')} ${Math.round(performance.now() - startedAt)}ms`,
      context.peekSession()?.user?.id ?? 'anonymous',
    )
  }
})

const boardSchema = v.object({
  id: v.string(),
  name: v.string(),
  ownerId: v.string(),
  createdAt: v.date(),
})

// oRPC custom procedures mounted alongside CRUD
export const api = {
  // Third-party POSTs use the same graph. `getRawBody()` preserves the exact
  // bytes needed by signature schemes without resolving an auth session.
  exampleWebhook: o.webhook
    .route({
      method: 'POST',
      path: '/webhooks/example',
      inputStructure: 'detailed',
    })
    .input(
      v.object({
        params: v.optional(v.object({}), {}),
        query: v.optional(v.record(v.string(), v.unknown()), {}),
        headers: v.record(v.string(), v.unknown()),
        body: v.record(v.string(), v.unknown()),
      }),
    )
    .handler(async ({ context, input }) => ({
      received: true,
      signatureMatches:
        input.headers['x-example-signature'] === (await context.getRawBody()),
    })),

  myBoards: o.protected
    .route({ method: 'GET', path: '/api/my-boards', tags: ['boards'] })
    .input(v.optional(v.object({})))
    .output(v.array(boardSchema))
    .handler(async ({ context }) =>
      context.db
        .select()
        .from(schema.boards)
        .where(eq(schema.boards.ownerId, asTypeId('user', context.user.id)))
        .orderBy(desc(schema.boards.createdAt))
        .all(),
    ),

  createBoard: o.protected
    .route({
      method: 'POST',
      path: '/api/create-board',
      tags: ['boards'],
      successStatus: 201,
    })
    .input(v.object({ name: v.pipe(v.string(), v.minLength(1)) }))
    .output(boardSchema)
    .handler(async ({ context, input }) => {
      const [board] = await context.db
        .insert(schema.boards)
        .values({
          name: input.name,
          ownerId: asTypeId('user', context.user.id),
        })
        .returning()
      return board!
    }),

  stats: o.protected
    .route({ method: 'GET', path: '/api/board-stats', tags: ['boards'] })
    .input(v.object({ boardId: v.string() }))
    .output(
      v.object({
        total: v.number(),
        done: v.number(),
        pending: v.number(),
      }),
    )
    .handler(async ({ context, input }) => {
      const all = await context.db
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

  complete: o.protected
    .route({ method: 'POST', path: '/api/complete-todo', tags: ['todos'] })
    .input(v.object({ id: v.string() }))
    .output(v.object({ ok: v.boolean() }))
    .handler(async ({ context, input }) => {
      const todo = await context.db
        .select()
        .from(schema.todos)
        .where(eq(schema.todos.id, asTypeId('todo', input.id)))
        .get()

      if (!todo) throw new Error('Todo not found')

      await context.db
        .update(schema.todos)
        .set({ done: true, completedAt: new Date() })
        .where(eq(schema.todos.id, asTypeId('todo', input.id)))

      if (context.env.NOTIFY_COMPLETED) {
        await context.email.send({
          to: context.user.email!,
          subject: `✅ Completed: ${todo.title}`,
          text: `Hi ${context.user.name},\n\nYou completed "${todo.title}".\n\n— ${context.env.PUBLIC_APP_NAME}`,
        })
      }

      const stillPending = await context.db
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
        await context.jobs.enqueue(
          'celebrateBoardComplete',
          { boardId: todo.boardId },
          { dedupeKey: `board-complete:${todo.boardId}` },
        )
      }

      return { ok: true }
    }),
}
