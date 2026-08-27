import { bunderstack, generateTypeId } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'

import type { AgentRuntimeContext, EnqueuedJob } from './agent/runtime'

import * as schema from './schema'

export interface TestApp {
  ctx: AgentRuntimeContext
  enqueued: EnqueuedJob[]
  seedUser(name: string): Promise<string>
  close(): Promise<void>
}

export async function createTestApp(): Promise<TestApp> {
  const backend = bunderstack({
    schema,
    database: { adapter: libsql() },
    auth: {
      baseURL: 'http://localhost:3007',
      secret: 'test-secret-test-secret-test-secret',
      advanced: { database: { generateId: () => false } },
    },
    realtime: true,
  })
  const fixture = await backend.test({ database: { schema: 'push' } })
  const { app } = fixture

  const enqueued: EnqueuedJob[] = []
  const ctx: AgentRuntimeContext = {
    db: app.db,
    realtime: app.realtime,
    jobs: {
      async enqueue(name, input, options = {}) {
        enqueued.push({ name, input, options })
      },
    },
  }

  return {
    ctx,
    enqueued,
    async seedUser(name) {
      const id = generateTypeId('user')
      const now = new Date()
      await app.db.insert(schema.user).values({
        id,
        name,
        email: `${id}@example.test`,
        emailVerified: false,
        isAnonymous: true,
        createdAt: now,
        updatedAt: now,
      })
      return id
    },
    close: () => fixture.close(),
  }
}
