// src/handler.ts
import { Hono } from 'hono'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

interface HandlerParts {
  crudRouter: Hono
  authHandler?: (req: Request) => Promise<Response>
  storageRouter?: Hono
}

export function buildHandler(parts: HandlerParts): {
  handler: (req: Request) => Promise<Response>
  router: Hono
} {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.route('/api', parts.crudRouter)

  if (parts.authHandler) {
    app.on(['GET', 'POST'], '/auth/*', (c) => parts.authHandler!(c.req.raw))
  }

  if (parts.storageRouter) {
    app.route('/files', parts.storageRouter)
  }

  return { handler: app.fetch.bind(app), router: app }
}
