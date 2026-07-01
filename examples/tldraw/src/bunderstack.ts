import { createBunderstack } from 'bunderstack'

import { access } from './access'
import * as schema from './schema'

export const app = createBunderstack({
  schema,
  access,
  database: { url: process.env.DATABASE_URL ?? 'file:./data.db' },
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
    emailAndPassword: { enabled: true },
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    advanced: {
      database: {
        generateId: () => false,
      },
    },
  },
  storage: {
    local: './uploads',
    defaultBucket: 'images',
    buckets: {
      images: {
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
  realtime: true,
})
