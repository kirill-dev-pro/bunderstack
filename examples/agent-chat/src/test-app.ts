import { createBunderstack, generateTypeId } from 'bunderstack'
import { type } from 'arktype'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'

import type { AgentRuntimeContext, EnqueuedJob } from './agent/runtime'

import { access } from './access'
import { api } from './api'
import * as schema from './schema'

export interface TestApp {
  app: {
    auth: unknown
    handler(request: Request): Promise<Response>
  }
  ctx: AgentRuntimeContext
  enqueued: EnqueuedJob[]
  seedUser(name: string): Promise<string>
  close(): Promise<void>
}

export async function createTestApp(): Promise<TestApp> {
  const databaseDir = await mkdtemp(join(tmpdir(), 'bunderstack-agent-chat-'))
  const app = await createBunderstack({
    schema,
    access,
    database: { adapter: libsql(), url: `file:${join(databaseDir, 'test.db')}` },
    auth: {
      baseURL: 'http://localhost:3007',
      secret: 'test-secret-test-secret-test-secret',
      advanced: { database: { generateId: () => false } },
    },
    realtime: true,
    jobs: (j) =>
      j.define({
        agentTurn: j.job({
          input: type({ threadId: 'string', reason: 'string' }),
          handler: async () => {},
        }),
        agentReminder: j.job({
          input: type({ commitmentId: 'string' }),
          handler: async () => {},
        }),
      }),
    api,
  })
  await provision(app)

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
    app,
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
    async close() {
      await app.close()
      await rm(databaseDir, { recursive: true, force: true })
    },
  }
}
