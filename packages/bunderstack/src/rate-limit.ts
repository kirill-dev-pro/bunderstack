import { createMemoryRateLimitStore, type RateLimitStore } from './platform'

export type RateLimitConfig = {
  windowMs?: number
  max?: number
  skip?: (req: Request) => boolean
}

function resolveConfig(
  config: boolean | RateLimitConfig | undefined,
): RateLimitConfig | null {
  if (!config) return null
  if (config === true) return {}
  return config
}

function clientKey(req: Request): string {
  const cloudflare = req.headers.get('cf-connecting-ip')
  if (cloudflare) return cloudflare
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('x-real-ip') ?? 'local'
}

export function createRateLimiter(
  config: boolean | RateLimitConfig | undefined,
  store: RateLimitStore = createMemoryRateLimitStore(),
): (req: Request) => Promise<Response | null> {
  const resolved = resolveConfig(config)
  if (!resolved) {
    return async (_req: Request) => null
  }

  const windowMs = resolved.windowMs ?? 60_000
  const max = resolved.max ?? 100

  return async (req: Request): Promise<Response | null> => {
    if (resolved.skip?.(req)) return null

    const key = `${clientKey(req)}:${new URL(req.url).pathname}`
    const now = Date.now()
    const { allowed, resetAt } = await store.hit(key, windowMs, max, now)
    if (allowed) return null

    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000))
    return new Response(
      JSON.stringify({
        error: 'Too many requests',
        code: 'TOO_MANY_REQUESTS',
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      },
    )
  }
}
