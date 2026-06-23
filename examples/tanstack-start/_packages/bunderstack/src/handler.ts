// src/handler.ts
import { Hono } from 'hono'

import { createRateLimiter, type RateLimitConfig } from './rate-limit.ts'

interface HandlerParts {
  crudRouter: Hono
  authHandler?: (req: Request) => Promise<Response>
  storageRouter?: Hono
  rateLimit?: boolean | RateLimitConfig
}

export function buildHandler(parts: HandlerParts): {
  handler: (req: Request) => Promise<Response>
  router: Hono
} {
  const app = new Hono()
  const checkRateLimit = createRateLimiter(parts.rateLimit)

  const health = (c: { json: (data: unknown) => Response }) =>
    c.json({ status: 'ok' })
  app.get('/health', health)
  app.get('/api/health', health)
  app.route('/api', parts.crudRouter)

  if (parts.authHandler) {
    app.all('/api/auth/*', (c) => parts.authHandler!(c.req.raw))
  }

  if (parts.storageRouter) {
    app.route('/api/files', parts.storageRouter)
    app.route('/files', parts.storageRouter)
  }

  const inner = (req: Request): Promise<Response> => Promise.resolve(app.fetch(req))
  const handler = async (req: Request): Promise<Response> => {
    const limited = await checkRateLimit(req)
    if (limited) return limited
    return inner(req)
  }
  return { handler, router: app }
}
