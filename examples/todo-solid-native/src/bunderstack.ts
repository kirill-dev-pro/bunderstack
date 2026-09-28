import { bunderstack, generateTypeId, typeid } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
// Bunderstack's own tables — file metadata, idempotency, jobs, email log.
import * as internal from 'bunderstack/schema'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const todos = sqliteTable('todos', {
  id: typeid('todo')
    .primaryKey()
    .$defaultFn(() => generateTypeId('todo')),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

/**
 * The backend definition only. `src/worker.ts` starts it inside the Worker;
 * `bunderstack dev` imports it to push the schema.
 */
export const backend = bunderstack({
  schema: { ...internal, todos },
  access: {
    todos: {
      crud: true,
      list: 'public',
      get: 'public',
      create: 'public',
      update: 'public',
      delete: 'public',
      writableColumns: ['title', 'done'],
      sortableColumns: ['createdAt', 'done'],
      defaultSort: { column: 'createdAt', order: 'desc' },
    },
  },
  // libsql over HTTP: sqld in dev, Turso or sqld in production.
  database: { adapter: libsql() },
  // Broadcast every CRUD write over SSE. The client consumes the stream
  // as a plain async iterator — see src/native/todos.ts.
  realtime: true,
})

/** Type handle for client inference — no server code reaches the bundle. */
export type App = Awaited<ReturnType<typeof backend.start>>
