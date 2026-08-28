import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'

import { access } from './access'
import * as schema from './schema'

export const backend = bunderstack({
  schema,
  access,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
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

export const app = await backend.start()

/** Type-only handle for client inference (`bunderstackStart<App>()`). */
export type App = typeof app
