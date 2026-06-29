export type RateLimitConfig = {
  windowMs?: number
  max?: number
  skip?: (req: Request) => boolean
}

type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

function resolveConfig(
  config: boolean | RateLimitConfig | undefined,
): RateLimitConfig | null {
  if (!config) return null
  if (config === true) return {}
  return config
}

function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('x-real-ip') ?? 'local'
}

export function createRateLimiter(
  config: boolean | RateLimitConfig | undefined,
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
    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    bucket.count += 1
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      return new Response(
        JSON.stringify({
          error: 'Too many requests',
          code: 'RATE_LIMITED',
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

    return null
  }
}
