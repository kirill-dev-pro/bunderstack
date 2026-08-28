import { organization } from 'better-auth/plugins'
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
import { provision } from 'bunderstack/provision'

import { access } from './access.ts'
import * as schema from './schema.ts'

export const backend = bunderstack({
  schema,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:5174',
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  },
  access,
  realtime: true,
})

export const app = await backend.start()

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)

export const { db, auth } = app

/** Type handle for client inference — no server code in the bundle. */
export type App = typeof app
