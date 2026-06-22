import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

// Mount app.handler at /api/** to serve auth + CRUD + storage.
// Reach into app.db, app.auth, app.storage directly in server functions.
export const app = createBunderstack({
  schema,
  auth: {
    emailPassword: true,
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
  },
  storage: { local: './uploads' },
})
