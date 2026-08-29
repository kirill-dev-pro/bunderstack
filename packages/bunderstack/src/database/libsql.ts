import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DatabaseAdapter } from './adapter'

export function libsql(): DatabaseAdapter {
  return {
    dialect: 'sqlite',
    driver: 'libsql',
    async connect(schema, connection) {
      if (
        connection.url.startsWith('postgres://') ||
        connection.url.startsWith('postgresql://')
      ) {
        throw new Error(
          '[bunderstack] libsql adapter cannot connect to a Postgres URL',
        )
      }
      const db = drizzle({ connection, schema })
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
