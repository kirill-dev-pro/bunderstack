import { organization } from 'better-auth/plugins'
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'

import { access } from './access.ts'
import * as schema from './schema.ts'

export const app = await createBunderstack({
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

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)

export const { db, auth } = app
