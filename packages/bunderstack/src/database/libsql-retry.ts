/**
 * A remote libSQL database (Turso, sqld) is reached over HTTP, and a pooled
 * connection the far side has already dropped fails the next request with
 * ECONNRESET, or the edge in front of it answers 502/520 for a moment. Those
 * show up as a 500 on a plain page load. A request that only reads can be
 * sent again safely, so it is, once; anything that could write is never
 * replayed, because the first attempt may have reached the database.
 */

type Fetch = (request: Request) => Promise<Response>

const RETRY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 524])
const RETRY_DELAY_MS = 100

type Stmt = { sql?: unknown }
type PipelineRequest = {
  type?: unknown
  stmt?: Stmt
  batch?: { steps?: Array<{ stmt?: Stmt }> }
}

const READ_ONLY_SQL = /^\s*(select|explain)\b/i
const WRITE_KEYWORD = /\b(insert|update|delete|replace|create|drop|alter)\b/i

function isReadOnlySql(sql: unknown): boolean {
  if (typeof sql !== 'string') return false
  if (READ_ONLY_SQL.test(sql)) return true
  // `with … select` is a read; `with … insert` is not.
  return /^\s*with\b/i.test(sql) && !WRITE_KEYWORD.test(sql)
}

/** True when a Hrana pipeline body outside a transaction only reads. */
export function isReadOnlyPipeline(body: string): boolean {
  let parsed: { baton?: unknown; requests?: unknown }
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  // A baton continues an open stream, for example an interactive
  // transaction; replaying one request of it out of context is wrong.
  if (parsed.baton !== null && parsed.baton !== undefined) return false
  if (!Array.isArray(parsed.requests) || parsed.requests.length === 0)
    return false
  let reads = 0
  for (const request of parsed.requests as PipelineRequest[]) {
    if (request.type === 'close') continue
    if (request.type === 'execute') {
      if (!isReadOnlySql(request.stmt?.sql)) return false
      reads++
      continue
    }
    if (request.type === 'batch') {
      const steps = request.batch?.steps
      if (!Array.isArray(steps) || steps.length === 0) return false
      if (!steps.every((step) => isReadOnlySql(step.stmt?.sql))) return false
      reads++
      continue
    }
    return false
  }
  return reads > 0
}

export function retryingReadFetch(
  inner: Fetch,
  delay: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Fetch {
  return async (request) => {
    const contentType = request.headers.get('content-type') ?? ''
    if (request.method !== 'POST' || !contentType.includes('json'))
      return inner(request)
    const body = await request.text()
    const send = () =>
      inner(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        }),
      )
    if (!isReadOnlyPipeline(body)) return send()
    let response: Response
    try {
      response = await send()
    } catch {
      await delay(RETRY_DELAY_MS)
      return send()
    }
    if (!RETRY_STATUSES.has(response.status)) return response
    await response.body?.cancel().catch(() => {})
    await delay(RETRY_DELAY_MS)
    return send()
  }
}

export function isRemoteLibsqlUrl(url: string): boolean {
  return /^(libsql|https?|wss?):\/\//i.test(url)
}
