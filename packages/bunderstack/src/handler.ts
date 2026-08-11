// src/handler.ts
import { createRateLimiter, type RateLimitConfig } from './rate-limit'

interface HandlerParts {
  authHandler?: (req: Request) => Promise<Response>
  apiHandler?: (req: Request) => Promise<Response | null>
  rateLimit?: boolean | RateLimitConfig
}

export function buildHandler(parts: HandlerParts): (req: Request) => Promise<Response> {
  const checkRateLimit = createRateLimiter(parts.rateLimit)

  return async (req: Request): Promise<Response> => {
    const limited = await checkRateLimit(req)
    if (limited) return limited

    const pathname = new URL(req.url).pathname
    if (
      parts.authHandler &&
      (pathname === '/api/auth' || pathname.startsWith('/api/auth/'))
    ) {
      return parts.authHandler(req)
    }
    if (parts.apiHandler) {
      const apiRes = await parts.apiHandler(req)
      if (apiRes) return apiRes
    }
    return new Response('Not Found', { status: 404 })
  }
}
