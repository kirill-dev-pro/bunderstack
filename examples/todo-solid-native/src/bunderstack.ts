import { bunderstack } from 'bunderstack'
import { generateTypeId, typeid } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
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

  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },

  // Broadcast every CRUD write over SSE. The client consumes the stream
  // as a plain async iterator — see src/native/sse.ts.
  realtime: true,
})

/**
 * One app per process, kept on `globalThis` so Vite's dev server cannot boot
 * two instances (and two in-memory realtime brokers) by evaluating this
 * module twice.
 */
const cache = globalThis as typeof globalThis & {
  __todoApp?: ReturnType<typeof backend.start>
}

export const app = await (cache.__todoApp ??= backend.start())

/** Type handle for client inference — no server code reaches the bundle. */
export type App = typeof app
