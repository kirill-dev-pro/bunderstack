import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      const db = drizzle(dataDir, { schema })
      return { db: db as never, close: () => db.$client.close() }
    },
    async migrate(db, migrationsFolder) {
      await migrate(db as never, { migrationsFolder })
    },
    testing: {
      async createTarget({ mode }) {
        if (mode === 'memory') {
          return {
            connection: { url: 'memory://' },
            async [Symbol.asyncDispose]() {},
          }
        }
        const directory = await mkdtemp(join(tmpdir(), 'bunderstack-test-'))
        let closed = false
        return {
          connection: { url: `file:${directory}` },
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
