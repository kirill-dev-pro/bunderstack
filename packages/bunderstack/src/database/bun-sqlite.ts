import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DatabaseAdapter } from './adapter'

const REMOTE_RE = /^(postgres(ql)?|libsql|wss?|https?):\/\//

/** `file:./data.db` and a bare path both name a local file for bun:sqlite. */
function toFilename(url: string): string {
  if (REMOTE_RE.test(url)) {
    throw new Error(
      '[bunderstack] bunSqlite adapter connects to a local file only. ' +
        'Use the libsql adapter for a remote libsql/Turso database.',
    )
  }
  if (url === ':memory:' || url === '') return ':memory:'
  return url.startsWith('file:') ? url.slice('file:'.length) : url
}

/**
 * Bun's built-in SQLite, through drizzle's `bun-sqlite` driver. Local files and
 * `:memory:` only — no network, no extra dependency. Reach for {@link libsql}
 * instead when the database is remote (Turso) or has an auth token.
 */
export function bunSqlite(): DatabaseAdapter {
  return {
    dialect: 'sqlite',
    driver: 'bun-sqlite',
    async connect(schema, { url }) {
      const db = drizzle(toFilename(url), { schema })
      return { db: db as never, close: () => db.$client.close() }
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
    testing: {
      async createTarget({ mode }) {
        if (mode === 'memory') {
          return {
            connection: { url: ':memory:' },
            async [Symbol.asyncDispose]() {},
          }
        }
        const directory = await mkdtemp(join(tmpdir(), 'bunderstack-test-'))
        let closed = false
        return {
          connection: { url: `file:${join(directory, 'database.db')}` },
          async [Symbol.asyncDispose]() {
            if (closed) return
            closed = true
            await rm(directory, { recursive: true, force: true })
          },
        }
      },
    },
  }
}
