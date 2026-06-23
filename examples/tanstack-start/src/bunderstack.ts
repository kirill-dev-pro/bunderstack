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
  storage: { local: './uploads' },
  storageOptions: {
    access: { create: 'authenticated', get: 'public', delete: 'owner' },
    uploadRules: {
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      maxSizeBytes: 10 * 1024 * 1024,
    },
  },
})
