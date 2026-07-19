import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { mkdir } from 'node:fs/promises'

import type { DatabaseAdapter } from './adapter'

const rawPath = (url: string) =>
  url.startsWith('file:') ? url.slice('file:'.length) : url

export function pglite(): DatabaseAdapter {
  return {
    dialect: 'pg',
    driver: 'pglite',
    async connect(schema, { url }) {
      if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
        throw new Error(
          '[bunderstack] pglite adapter cannot connect to a Postgres URL',
        )
      }
      const raw = rawPath(url)
      const dataDir = raw === ':memory:' ? 'memory://' : raw
      if (!dataDir.startsWith('memory://'))
        await mkdir(dataDir, { recursive: true })
      return drizzle(dataDir, { schema }) as never
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
  }
}
