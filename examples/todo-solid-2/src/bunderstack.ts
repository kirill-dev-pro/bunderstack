import { createBunderstack, defineApi } from 'bunderstack'
import { generateTypeId, typeid } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
// Bunderstack's own tables — file metadata, idempotency, jobs, email log.
// They belong in the schema map, not just in the database: the runtime reads
// them from here.
import * as internal from 'bunderstack/schema'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { randomWord, sleep, summaryLength, tokenDelay } from './fake-llm'

export const todos = sqliteTable('todos', {
  id: typeid('todo')
    .primaryKey()
    .$defaultFn(() => generateTypeId('todo')),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),

  // Written only by the enrichTodos job. `summary` accumulates every word
  // generated so far, so the row carries the whole stream and a client that
  // reconnects mid-generation needs no replay.
  summary: text('summary'),
  summaryStatus: text('summaryStatus', {
    enum: ['idle', 'queued', 'streaming', 'done', 'failed'],
  })
    .notNull()
    .default('idle'),
})

const schema = { ...internal, todos }

const o = defineApi({ schema })

function createApp() {
  return createBunderstack({
    schema,

    access: {
      todos: {
        crud: true,
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
        // An explicit allowlist: everything else on the table is server-owned.
        writableColumns: ['title', 'done'],
        sortableColumns: ['createdAt', 'done'],
        defaultSort: { column: 'createdAt', order: 'desc' },
      },
    },

    database: {
      adapter: libsql(),
      url: process.env.DATABASE_URL ?? 'file:./data.db',
    },

    // Broadcast every CRUD write over SSE. The client consumes the typed
    // Publisher iterator through `syncRealtime` — see src/TodoList.tsx.
    realtime: true,

    // Declaring jobs starts an in-process worker (BUNDERSTACK_ROLE defaults to
    // `all`), which is also what makes realtime work: a worker in a separate
    // process could not reach this one's in-memory broker without Redis.
    jobs: (j) =>
      j.define({
        enrichTodos: j.job({
          input: v.object({ ids: v.array(v.string()) }),
          handler: async (input, ctx) => {
            for (const id of input.ids) {
              const [started] = await ctx.db
                .update(todos)
                .set({ summaryStatus: 'streaming' })
                .where(eq(todos.id, id as never))
                .returning()
              if (!started) continue
              await ctx.realtime.publish(todos, 'update', started)

              // The accumulated text is republished in full on every word, so
              // the row is the entire state of the stream. A client that drops
              // and refetches sees exactly what it missed, with no replay.
              let summary = ''
              const words = summaryLength()
              for (let i = 0; i < words; i++) {
                await sleep(tokenDelay())
                summary += (summary ? ' ' : '') + randomWord()
                const [row] = await ctx.db
                  .update(todos)
                  .set({ summary })
                  .where(eq(todos.id, id as never))
                  .returning()
                if (row) await ctx.realtime.publish(todos, 'update', row)
              }

              const [finished] = await ctx.db
                .update(todos)
                .set({ summaryStatus: 'done' })
                .where(eq(todos.id, id as never))
                .returning()
              if (finished) {
                await ctx.realtime.publish(todos, 'update', finished)
              }
            }
          },
          onFailed: async (input, _error, ctx) => {
            // Rows the handler never reached, or died part-way through, would
            // otherwise sit in the UI spinning forever.
            const rows = await ctx.db
              .update(todos)
              .set({ summaryStatus: 'failed' })
              .where(
                and(
                  inArray(todos.id, input.ids as never[]),
                  ne(todos.summaryStatus, 'done'),
                ),
              )
              .returning()
            for (const row of rows) {
              await ctx.realtime.publish(todos, 'update', row)
            }
          },
        }),
      }),

    // One custom procedure: claim the idle rows, then queue the work.
    api: {
      enrich: o.public
        .route({ method: 'POST', path: '/api/enrich', tags: ['jobs'] })
        // An explicit empty input, so the generated client's call signature is
        // `call({})` rather than a no-argument call.
        .input(v.object({}))
        .output(v.object({ queued: v.number() }))
        .handler(async ({ context }) => {
          // Claiming here rather than in the handler makes the button reflect
          // reality immediately, and makes a second click a no-op instead of a
          // duplicate enqueue.
          const rows = await context.db
            .update(todos)
            .set({ summaryStatus: 'queued' })
            .where(eq(todos.summaryStatus, 'idle'))
            .returning()

          for (const row of rows) {
            await context.realtime.publish(todos, 'update', row)
          }
          if (rows.length > 0) {
            await context.jobs.enqueue('enrichTodos', {
              ids: rows.map((row) => row.id),
            })
          }
          return { queued: rows.length }
        }),
    },
  })
}

/**
 * One app per process, kept on `globalThis`.
 *
 * Vite's dev server can evaluate this module more than once, and each
 * evaluation would otherwise build its own Bunderstack — including its own
 * in-memory realtime publisher and its own job worker. A write handled by one
 * instance would then publish to a broker no subscriber is listening to, and
 * realtime would work in production and silently do nothing in dev.
 *
 * The promise is cached rather than the resolved app, so concurrent first
 * requests share one boot instead of racing to create two.
 */
const cache = globalThis as typeof globalThis & {
  __todoApp?: ReturnType<typeof createApp>
}

export const app = await (cache.__todoApp ??= createApp())

/** Type handle for client inference — no server code reaches the bundle. */
export type App = typeof app

// Provisioning lives in src/provision.ts, which `bun run dev` and
// `bun run start` run before serving — not here. Importing this module must
// not push schema: Vite's dev server imports it to answer /api requests, and
// drizzle-kit does not resolve inside Vite's module runner.
