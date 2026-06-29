import { createBunderstackAsync } from 'bunderstack'

import { access } from './access'
import * as schema from './schema'

export const app = await createBunderstackAsync({
  schema,
  access,
  database: { url: process.env.DATABASE_URL ?? 'file:./data.db' },
  auth: {
    baseURL: process.env.APP_URL,
    emailAndPassword: { enabled: true },
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
  },
  storage: {
    local: './uploads',
    defaultBucket: 'attachments',
    buckets: {
      avatars: {
        visibility: 'public',
        access: { create: 'authenticated', get: 'public', delete: 'owner' },
        upload: {
          maxSize: '2mb',
          accept: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        },
        transforms: true,
      },
      attachments: {
        visibility: 'public',
        access: { create: 'authenticated', get: 'public', delete: 'owner' },
        upload: {
          maxSize: '10mb',
          accept: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        },
        transforms: true,
      },
    },
  },
})
