import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'

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
      return drizzle({ connection, schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
