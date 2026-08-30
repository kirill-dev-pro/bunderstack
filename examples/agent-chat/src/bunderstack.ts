import { type } from 'arktype'
import { anonymous } from 'better-auth/plugins'
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
import { provision } from 'bunderstack/provision'

import { access } from './access'
import { transferAnonymousAgentData } from './agent/auth-transfer'
import { executeCommitment } from './agent/commitments'
import { generateFriendlyName } from './agent/friendly-name'
import { createAIResponder } from './agent/model'
import { fireCommitment, runAgentTurn } from './agent/runtime'
import { api } from './api'
import { envSchema } from './env'
import * as schema from './schema'

export const backend = bunderstack({
  schema,
  access,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
  auth: ({ db }) => ({
    baseURL: process.env.APP_URL ?? 'http://localhost:3007',
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    emailAndPassword: { enabled: true },
    plugins: [
      anonymous({
        generateName: () => generateFriendlyName(),
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          await transferAnonymousAgentData(
            db,
            anonymousUser.user.id,
            newUser.user.id,
          )
        },
      }),
    ],
    advanced: { database: { generateId: () => false } },
  }),
  env: envSchema,
  realtime: true,
  jobs: (j) =>
    j.define({
      agentTurn: j.job({
        input: type({
          threadId: 'string',
          reason: 'string',
          'runId?': 'string',
          'requestId?': 'string',
          'executionKey?': 'string',
        }),
        retries: 3,
        concurrency: 4,
        timeout: 120_000,
        handler: async (input, ctx) => {
          const responder = createAIResponder({
            apiKey: ctx.env.AI_API_KEY,
            baseURL: ctx.env.AI_BASE_URL,
            model: ctx.env.AI_MODEL,
          })
          await runAgentTurn(ctx, input, responder)
        },
      }),
      agentReminder: j.job({
        input: type({ commitmentId: 'string' }),
        retries: 3,
        handler: async ({ commitmentId }, ctx) => {
          await fireCommitment(ctx, commitmentId)
        },
      }),
      agentCommitment: j.job({
        input: type({
          commitmentId: 'string',
          'runId?': 'string',
          'requestId?': 'string',
        }),
        retries: 3,
        concurrency: 4,
        timeout: 120_000,
        handler: async (input, ctx) => {
          const responder = createAIResponder({
            apiKey: ctx.env.AI_API_KEY,
            baseURL: ctx.env.AI_BASE_URL,
            model: ctx.env.AI_MODEL,
          })
          await executeCommitment(ctx, input, responder)
        },
      }),
    }),
  api,
})

export const app = await backend.start()

export type App = typeof app

await provision(app)

// The example intentionally embeds the queue worker so its memory-realtime
// publications reach the same process that owns the SSE connections. A
// multi-process deployment should configure Redis and run a separate worker.
await app.startWorker()
