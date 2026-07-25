import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import type {
  DatabaseAdapter,
  DatabaseConnection,
  DatabaseConnectOptions,
} from './adapter'

export function postgresJs(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'postgres-js',
    async connect<TSchema extends Record<string, unknown>>(
      schema: TSchema,
      { url }: DatabaseConnection,
      { introspect }: DatabaseConnectOptions,
    ) {
      if (introspect) return { db: drizzle.mock({ schema }) as never }

      if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
        throw new Error(
          '[bunderstack] postgresJs adapter requires a Postgres URL',
        )
      }
      const db = drizzle<TSchema>({ connection: url, schema })
      return { db: db as never, close: () => db.$client.end() }
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
