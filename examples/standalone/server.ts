// examples/standalone/server.ts
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

const app = createBunderstack({
  schema,
  auth: { emailPassword: true },
  storage: { local: './examples/standalone/uploads' },
  storageOptions: {
    uploadRules: {
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxSizeBytes: 10 * 1024 * 1024,
    },
  },
})

// Expose raw instances for drop-down access
export const { db, auth, storage, router } = app

const server = Bun.serve({
  port: 3001,
  fetch: app.handler,
})

console.log(`Bunderstack POC running at http://localhost:${server.port}`)
console.log('Routes:')
console.log('  GET  /health')
console.log('  GET  /api/posts')
console.log('  POST /api/posts')
console.log('  POST /files         (multipart, field: file)')
console.log('  GET  /files/:id     (?w=&h=&format=webp for thumbnails)')
console.log('  POST /auth/sign-up/email')
console.log('  POST /auth/sign-in/email')
