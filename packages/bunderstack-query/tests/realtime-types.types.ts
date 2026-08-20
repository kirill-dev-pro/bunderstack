import { createBunderstack } from 'bunderstack'
import { pglite } from 'bunderstack/database/pglite'
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { syncRealtime, type RealtimeChange } from '../src/index'

/**
 * Type-level checks for `syncRealtime`'s app-typed form.
 *
 * Supplying the app type narrows `tables` to the exposed table names and
 * `onChange` to a union discriminated by `table`. Omitting it keeps the loose
 * `RealtimeChange`, which is what consumers with only a structural client —
 * `bunderstack-sync` among them — rely on.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T

const todos = pgTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  done: boolean('done').notNull(),
  createdAt: timestamp('createdAt').notNull(),
})

const privateNotes = pgTable('private_notes', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
})

const schema = { todos, privateNotes }

async function setupApp() {
  return await createBunderstack({
    schema,
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
    access: {
      todos: { crud: true, list: 'public', get: 'public' },
      privateNotes: { crud: false },
    },
    realtime: true,
  })
}

type App = Awaited<ReturnType<typeof setupApp>>

export async function testRealtimeTypes() {
  const app = await setupApp()
  const api = {
    realtime: { changes: { call: async () => [] as any } },
  } as any
  const queryClient = {} as any

  syncRealtime<App>({
    api,
    queryClient,
    tables: ['todos'],
    apply: 'patch',
    onChange: (change) => {
      // Discriminated by `table`, so the row type is available after narrowing.
      if (change.table === 'todos') {
        const done: boolean = change.record.done
        const title: string = change.record.title
        const createdAt: Date = change.record.createdAt
        void done
        void title
        void createdAt

        // @ts-expect-error the todos row has no `content` column
        void change.record.content
      }
    },
  })

  // @ts-expect-error a table with crud disabled is not exposed to realtime
  syncRealtime<App>({ api, queryClient, tables: ['privateNotes'] })

  // @ts-expect-error not a table on this app
  syncRealtime<App>({ api, queryClient, tables: ['nope'] })

  // Without the app type the change stays loose, as before.
  syncRealtime({
    api,
    queryClient,
    tables: ['anything', 'goes'],
    onChange: (change) => {
      const loose: Expect<Equal<typeof change, RealtimeChange>> = true
      void loose
      const record: Record<string, unknown> = change.record
      void record
    },
  })

  void app
}
