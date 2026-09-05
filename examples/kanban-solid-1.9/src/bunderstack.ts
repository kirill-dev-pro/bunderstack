import { organization } from 'better-auth/plugins'
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
import { provision } from 'bunderstack/provision'
import * as v from 'valibot'

import { access } from './access.ts'
import * as schema from './schema.ts'

/** Declared env. These names reach the manifest; the values never do. */
const envSchema = {
  server: {
    APP_URL: v.optional(v.string(), 'http://localhost:5174'),
  },
}

export const backend = bunderstack({
  schema,
  env: envSchema,
  database: { adapter: libsql() },
  auth: ({ env }) => ({
    baseURL: env.APP_URL,
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  }),
  access,
  realtime: true,
})

export const app = await backend.start()

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)

export const { db, auth } = app

/** Type handle for client inference — no server code in the bundle. */
export type App = typeof app
