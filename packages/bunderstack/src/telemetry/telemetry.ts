// The Bunderhost reporter. It switches on when the platform supplies
// BUNDERHOST_TELEMETRY_URL and BUNDERHOST_TELEMETRY_TOKEN, aggregates request
// and job samples into window deltas, folds identical errors, and ships one
// JSON batch at a time. Nothing in here may throw into application code, and
// nothing is sent from a process without the two variables, so `bun dev`
// stays silent.
import type { BaseEnv } from '../env'
import type { BunderstackLogger } from '../logging'

import { consoleLogger } from '../logging'

export type TelemetrySource = 'api' | 'job' | 'cron' | 'process' | 'http'

export type TelemetryContext = {
  source: TelemetrySource
  [key: string]: string | number | boolean | undefined
}

export type TelemetryConfig = {
  url: string
  token: string
  release?: string
  runtime: 'bunderstack' | 'workerstack'
  version: string
}

export type RequestSample = {
  route: string
  status: number
  durationMs: number
}
export type JobSample = {
  type: string
  kind: 'job' | 'cron'
  outcome: 'succeeded' | 'failed' | 'retrying'
  durationMs: number
}

export type TelemetrySink = {
  readonly enabled: boolean
  captureException(error: unknown, context: TelemetryContext): void
  recordRequest(sample: RequestSample): void
  recordJob(sample: JobSample): void
  /** Sends what is queued; resolves when the request settled or was dropped. */
  flush(): Promise<void>
  /** Sends only when the window elapsed or the queue is full. */
  flushIfDue(): Promise<void>
}

export type Telemetry = TelemetrySink & {
  /** Starts the periodic flush (Bun); a Worker calls flushIfDue instead. */
  start(): void
  /** Stops the timer and sends the last window. */
  stop(): Promise<void>
}

export const REQUEST_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
]
export const JOB_BUCKETS_MS = [100, 500, 1000, 5000, 15000, 60000, 300000]
export const FLUSH_INTERVAL_MS = 15_000
export const MAX_QUEUED_ERRORS = 50
export const MAX_ERRORS_PER_BATCH = 100
export const MAX_METRICS_PER_BATCH = 2_000
export const MAX_ROUTE_LABELS = 500
const MAX_STACK_CHARS = 16_000
const MAX_MESSAGE_CHARS = 2_000
const MAX_CONTEXT_CHARS = 2_048
const WARN_EVERY_MS = 5 * 60_000

export function telemetryFromEnv(
  env: Pick<
    BaseEnv,
    'BUNDERHOST_TELEMETRY_URL' | 'BUNDERHOST_TELEMETRY_TOKEN'
  > & {
    BUNDERSTACK_REVISION?: string
    WORKERSTACK_REVISION?: string
  },
  identity: { runtime: TelemetryConfig['runtime']; version: string },
): TelemetryConfig | null {
  const url = env.BUNDERHOST_TELEMETRY_URL?.trim()
  const token = env.BUNDERHOST_TELEMETRY_TOKEN?.trim()
  if (!url || !token) return null
  const release = env.BUNDERSTACK_REVISION ?? env.WORKERSTACK_REVISION
  return {
    url: url.replace(/\/+$/, ''),
    token,
    ...(release ? { release } : {}),
    ...identity,
  }
}

export const noopTelemetry: Telemetry = {
  enabled: false,
  captureException() {},
  recordRequest() {},
  recordJob() {},
  async flush() {},
  async flushIfDue() {},
  start() {},
  async stop() {},
}

type QueuedError = {
  source: TelemetrySource
  name: string
  message: string
  stack?: string
  occurredAt: string
  count: number
  context: Record<string, string | number | boolean>
}

type Histogram = { buckets: number[]; sum: number }

/** `2xx`…`5xx`; anything outside is `other`. */
export function statusClass(status: number): string {
  const hundreds = Math.floor(status / 100)
  return hundreds >= 1 && hundreds <= 5 ? `${hundreds}xx` : 'other'
}

export function describeError(error: unknown): {
  name: string
  message: string
  stack?: string
} {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: (error.message ?? '').slice(0, MAX_MESSAGE_CHARS),
      ...(error.stack ? { stack: error.stack.slice(0, MAX_STACK_CHARS) } : {}),
    }
  }
  if (typeof error === 'string')
    return { name: 'Error', message: error.slice(0, MAX_MESSAGE_CHARS) }
  let message: string
  try {
    message = JSON.stringify(error) ?? String(error)
  } catch {
    message = String(error)
  }
  return { name: 'Error', message: message.slice(0, MAX_MESSAGE_CHARS) }
}

function boundedContext(
  context: TelemetryContext,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue
    if (typeof value === 'string') out[key] = value.slice(0, 500)
    else if (typeof value === 'number' || typeof value === 'boolean')
      out[key] = value
    if (JSON.stringify(out).length > MAX_CONTEXT_CHARS) {
      delete out[key]
      break
    }
  }
  return out
}

export function createTelemetry(
  config: TelemetryConfig,
  deps: {
    fetch?: typeof fetch
    now?: () => number
    logger?: BunderstackLogger
    /** Bun: setInterval; Workers leave it undefined and call flushIfDue. */
    intervalMs?: number
  } = {},
): Telemetry {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const logger = deps.logger ?? consoleLogger
  const intervalMs = deps.intervalMs ?? FLUSH_INTERVAL_MS

  let errors: QueuedError[] = []
  let requests = new Map<string, Map<string, number>>()
  let requestLatency = new Map<string, Histogram>()
  let jobs = new Map<string, Map<string, number>>()
  let jobLatency = new Map<string, Histogram>()
  let errorsBySource = new Map<string, number>()
  let routes = new Set<string>()
  let lastFlushAt = now()
  let lastWarnAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined

  const routeLabel = (route: string) => {
    if (routes.has(route)) return route
    if (routes.size >= MAX_ROUTE_LABELS) return 'other'
    routes.add(route)
    return route
  }

  const histogram = (
    map: Map<string, Histogram>,
    key: string,
    buckets: number[],
  ) => {
    let entry = map.get(key)
    if (!entry) {
      entry = { buckets: new Array(buckets.length + 1).fill(0), sum: 0 }
      map.set(key, entry)
    }
    return entry
  }

  const observe = (entry: Histogram, buckets: number[], value: number) => {
    const ms = Math.max(0, value)
    for (let i = 0; i < buckets.length; i++)
      if (ms <= buckets[i]!) entry.buckets[i]!++
    entry.buckets[buckets.length]!++
    entry.sum += ms
  }

  const hasData = () =>
    errors.length > 0 ||
    requests.size > 0 ||
    jobs.size > 0 ||
    errorsBySource.size > 0

  const drain = () => {
    const at = new Date(now()).toISOString()
    const metrics: Array<{
      name: string
      labels: Record<string, string>
      value: number
    }> = []
    for (const [route, byStatus] of requests)
      for (const [status, value] of byStatus)
        metrics.push({
          name: 'bh_app_requests',
          labels: { route, status },
          value,
        })
    for (const [route, entry] of requestLatency) {
      REQUEST_BUCKETS_MS.forEach((le, i) =>
        metrics.push({
          name: 'bh_app_request_duration_ms_bucket',
          labels: { route, le: String(le) },
          value: entry.buckets[i]!,
        }),
      )
      metrics.push({
        name: 'bh_app_request_duration_ms_bucket',
        labels: { route, le: '+Inf' },
        value: entry.buckets[REQUEST_BUCKETS_MS.length]!,
      })
      metrics.push({
        name: 'bh_app_request_duration_ms_sum',
        labels: { route },
        value: entry.sum,
      })
    }
    for (const [key, byOutcome] of jobs) {
      const [type, kind] = key.split('\u0000') as [string, string]
      for (const [outcome, value] of byOutcome)
        metrics.push({
          name: 'bh_app_job_runs',
          labels: { type, kind, outcome },
          value,
        })
    }
    for (const [type, entry] of jobLatency) {
      JOB_BUCKETS_MS.forEach((le, i) =>
        metrics.push({
          name: 'bh_app_job_duration_ms_bucket',
          labels: { type, le: String(le) },
          value: entry.buckets[i]!,
        }),
      )
      metrics.push({
        name: 'bh_app_job_duration_ms_bucket',
        labels: { type, le: '+Inf' },
        value: entry.buckets[JOB_BUCKETS_MS.length]!,
      })
      metrics.push({
        name: 'bh_app_job_duration_ms_sum',
        labels: { type },
        value: entry.sum,
      })
    }
    for (const [source, value] of errorsBySource)
      metrics.push({ name: 'bh_app_errors', labels: { source }, value })
    const batch = {
      runtime: config.runtime,
      version: config.version,
      ...(config.release ? { release: config.release } : {}),
      sentAt: at,
      errors: errors.slice(0, MAX_ERRORS_PER_BATCH),
      metrics: metrics.slice(0, MAX_METRICS_PER_BATCH),
    }
    errors = []
    requests = new Map()
    requestLatency = new Map()
    jobs = new Map()
    jobLatency = new Map()
    errorsBySource = new Map()
    return batch
  }

  const send = async () => {
    if (!hasData()) return
    const batch = drain()
    lastFlushAt = now()
    try {
      const response = await fetchImpl(`${config.url}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok && response.status !== 204)
        warn(`Bunderhost answered ${response.status}`)
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error))
    }
  }

  const warn = (reason: string) => {
    const at = now()
    if (at - lastWarnAt < WARN_EVERY_MS) return
    lastWarnAt = at
    logger.warn(
      `[bunderstack] telemetry not delivered (${reason}); reports are dropped`,
    )
  }

  const flush = () => {
    if (inFlight) return inFlight
    inFlight = send().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const telemetry: Telemetry = {
    enabled: true,
    captureException(error, context) {
      try {
        const described = describeError(error)
        const { source, ...rest } = context
        const bounded = boundedContext(rest as TelemetryContext)
        errorsBySource.set(source, (errorsBySource.get(source) ?? 0) + 1)
        const existing = errors.find(
          (queued) =>
            queued.source === source &&
            queued.name === described.name &&
            queued.message === described.message &&
            queued.stack === described.stack,
        )
        if (existing) {
          existing.count++
          return
        }
        if (errors.length >= MAX_QUEUED_ERRORS) {
          void flush()
          if (errors.length >= MAX_QUEUED_ERRORS) return
        }
        errors.push({
          source,
          ...described,
          occurredAt: new Date(now()).toISOString(),
          count: 1,
          context: bounded,
        })
      } catch {
        /* never into application code */
      }
    },
    recordRequest(sample) {
      try {
        const route = routeLabel(sample.route)
        const status = statusClass(sample.status)
        let byStatus = requests.get(route)
        if (!byStatus) {
          byStatus = new Map()
          requests.set(route, byStatus)
        }
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
        observe(
          histogram(requestLatency, route, REQUEST_BUCKETS_MS),
          REQUEST_BUCKETS_MS,
          sample.durationMs,
        )
      } catch {
        /* never into application code */
      }
    },
    recordJob(sample) {
      try {
        const key = `${sample.type}\u0000${sample.kind}`
        let byOutcome = jobs.get(key)
        if (!byOutcome) {
          byOutcome = new Map()
          jobs.set(key, byOutcome)
        }
        byOutcome.set(sample.outcome, (byOutcome.get(sample.outcome) ?? 0) + 1)
        observe(
          histogram(jobLatency, sample.type, JOB_BUCKETS_MS),
          JOB_BUCKETS_MS,
          sample.durationMs,
        )
      } catch {
        /* never into application code */
      }
    },
    flush,
    async flushIfDue() {
      if (
        errors.length >= MAX_QUEUED_ERRORS ||
        now() - lastFlushAt >= intervalMs
      )
        await flush()
    },
    start() {
      if (timer) return
      timer = setInterval(() => void flush(), intervalMs)
      // A timer must not keep a process alive that is otherwise done.
      ;(timer as { unref?: () => void }).unref?.()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    },
  }
  return telemetry
}
