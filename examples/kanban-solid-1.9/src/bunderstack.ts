import { organization } from 'better-auth/plugins'
import { createBunderstackAsync } from 'bunderstack'

import { access } from './access.ts'
import * as schema from './schema.ts'

export const app = await createBunderstackAsync({
  schema,
  database: { url: process.env.DATABASE_URL ?? 'file:./data.db' },
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:5174',
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  },
  access,
  realtime: true,
})

export const { db, auth } = app
