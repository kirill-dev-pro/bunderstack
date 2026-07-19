import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

import type { DatabaseAdapter } from './adapter'

export function bunSql(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'bun-sql',
    async connect(schema, { url }) {
      if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
        throw new Error('[bunderstack] bunSql adapter requires a Postgres URL')
      }
      return drizzle(url, { schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
