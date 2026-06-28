// examples/standalone/server.ts
import { createBunderstackAsync } from 'bunderstack'

import * as schema from './schema'

const app = await createBunderstackAsync({
  schema,
  database: { url: 'file:./data.db' },
  auth: { emailAndPassword: { enabled: true } },
  access: {
    posts: { ownerColumn: 'authorId' },
  },
  storage: {
    local: './uploads',
    defaultBucket: 'uploads',
    buckets: {
      uploads: {
        upload: {
          maxSize: '10mb',
          accept: ['image/jpeg', 'image/png', 'image/webp'],
        },
        transforms: true,
      },
    },
  },
})

export const { db, auth, storage, router } = app

const server = Bun.serve({
  port: 3001,
  fetch: app.handler,
})

console.log(`Bunderstack running at http://localhost:${server.port}`)
console.log('Routes:')
console.log('  GET  /api/health')
console.log('  GET  /api/posts')
console.log('  POST /api/posts')
console.log('  POST /api/files/uploads         (multipart, field: file)')
console.log('  GET  /api/files/uploads/:id     (?w=&h=&format=webp for thumbnails)')
console.log('  POST /api/auth/sign-up/email')
console.log('  POST /api/auth/sign-in/email')
