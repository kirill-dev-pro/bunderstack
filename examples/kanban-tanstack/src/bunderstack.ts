import { organization } from 'better-auth/plugins'
import { createBunderstackAsync } from 'bunderstack'

import { access } from './access'
import * as schema from './schema'

export const app = await createBunderstackAsync({
  schema,
  database: { url: process.env.DATABASE_URL ?? 'file:./data.db' },
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:5175',
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  },
  access,
  realtime: true,
  storage: {
    local: './uploads',
    defaultBucket: 'attachments',
    buckets: {
      attachments: {
        visibility: 'public',
        access: { create: 'authenticated', get: 'public', delete: 'owner' },
        upload: {
          maxSize: '10mb',
          accept: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif',
            'application/pdf',
            'text/plain',
          ],
        },
        transforms: true,
      },
    },
  },
})

export const { db, auth } = app
