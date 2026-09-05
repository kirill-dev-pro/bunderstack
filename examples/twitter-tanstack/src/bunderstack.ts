import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
import * as v from 'valibot'

import { access } from './access'
import { api } from './api'
import * as schema from './schema'

/** Declared env. These names reach the manifest; the values never do. */
const envSchema = {
  server: {
    APP_URL: v.optional(v.string(), 'http://localhost:3000'),
  },
}

export const backend = bunderstack({
  schema,
  env: envSchema,
  access,
  database: { adapter: libsql() },
  auth: ({ env }) => ({
    baseURL: env.APP_URL,
    emailAndPassword: { enabled: true },
    advanced: {
      database: {
        generateId: () => false,
      },
    },
  }),
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
  api,
})

export const app = await backend.start()

export type App = typeof app
