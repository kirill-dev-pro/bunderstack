import { createServerFileRoute } from '@tanstack/react-start'
import { app } from '~/bunderstack'

// Mounts the Bunderstack handler at /api/**:
//   GET/POST /api/auth/**       — BetterAuth (sign-in, sign-up, sign-out, session)
//   GET/POST/PATCH/DELETE /api/posts  — auto-CRUD from Drizzle schema
//   GET/POST/DELETE /api/files  — file upload/serve (local storage)
export const ServerRoute = createServerFileRoute('/api/$').methods({
  GET: ({ request }) => app.handler(request),
  POST: ({ request }) => app.handler(request),
  PATCH: ({ request }) => app.handler(request),
  DELETE: ({ request }) => app.handler(request),
})
