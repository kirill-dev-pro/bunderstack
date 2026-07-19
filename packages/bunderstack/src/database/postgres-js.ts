import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import type { DatabaseAdapter } from './adapter'

export function postgresJs(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'postgres-js',
    async connect(schema, { url }) {
      if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
        throw new Error(
          '[bunderstack] postgresJs adapter requires a Postgres URL',
        )
      }
      return drizzle(url, { schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
