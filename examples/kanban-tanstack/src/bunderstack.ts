import { organization } from 'better-auth/plugins'
import { bunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'
import { provision } from 'bunderstack/provision'

import { access } from './access'
import * as schema from './schema'

const orgScope = (ctx: {
  session?: { activeOrganizationId: string | null } | null
}) => ({
  organizationId: ctx.session?.activeOrganizationId ?? '__none__',
})

export const backend = bunderstack({
  schema,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:5175',
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    emailAndPassword: { enabled: true },
    plugins: [organization()],
    // Ids come from the schema's `typeid()` defaults, not from Better Auth.
    advanced: { database: { generateId: () => false } },
  },
  access,
  realtime: true,
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
        visibility: 'private',
        access: {
          create: 'authenticated',
          get: 'authenticated',
          delete: 'owner',
        },
        scope: { read: orgScope, write: orgScope },
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

export const app = await backend.start()

// No migrations/ folder → dev push; committed migrations → applied on boot.
await provision(app)

export const { db, auth } = app
export type App = typeof app
