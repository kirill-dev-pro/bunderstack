import { ORPCError, os } from '@orpc/server'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

import { libsql } from '../database/libsql'
import { BunderstackError } from '../errors'
import { bunderstack, defineApi } from '../index'
import { normalizePath, withTelemetry } from '../start/index'
import { createTestLogs } from '../testing/logs'
import { telemetryMiddleware } from './middleware'
import { installProcessTelemetry } from './process'
import {
  createTelemetry,
  describeError,
  noopTelemetry,
  statusClass,
  telemetryFromEnv,
} from './telemetry'

type Batch = {
  runtime: string
  version: string
  release?: string
  sentAt: string
  errors: Array<Record<string, unknown>>
  metrics: Array<{
    name: string
    labels: Record<string, string>
    value: number
  }>
}

function harness(options: { status?: number; fail?: boolean } = {}) {
  const batches: Batch[] = []
  const requests: Request[] = []
  let now = 1_000_000
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    if (options.fail) throw new Error('connect ECONNREFUSED')
    batches.push((await request.json()) as Batch)
    return new Response(null, { status: options.status ?? 204 })
  }) as typeof fetch
  const { logger, logs } = createTestLogs()
  const telemetry = createTelemetry(
    {
      url: 'https://bunderhost.test/api/telemetry/v1',
      token: 'tok',
      release: 'rel1',
      runtime: 'bunderstack',
      version: '0.27.0',
    },
    { fetch: fetchImpl, now: () => now, logger },
  )
  return {
    telemetry,
    batches,
    requests,
    logs,
    advance: (ms: number) => void (now += ms),
  }
}

test('configuration needs both variables and picks up the release', () => {
  expect(
    telemetryFromEnv({}, { runtime: 'bunderstack', version: '1' }),
  ).toBeNull()
  expect(
    telemetryFromEnv(
      { BUNDERHOST_TELEMETRY_URL: 'https://x/api/telemetry/v1' },
      { runtime: 'bunderstack', version: '1' },
    ),
  ).toBeNull()
  expect(
    telemetryFromEnv(
      {
        BUNDERHOST_TELEMETRY_URL: 'https://x/api/telemetry/v1/',
        BUNDERHOST_TELEMETRY_TOKEN: 't',
        BUNDERSTACK_REVISION: 'abc',
      },
      { runtime: 'bunderstack', version: '1' },
    ),
  ).toEqual({
    url: 'https://x/api/telemetry/v1',
    token: 't',
    release: 'abc',
    runtime: 'bunderstack',
    version: '1',
  })
  expect(statusClass(204)).toBe('2xx')
  expect(statusClass(503)).toBe('5xx')
  expect(statusClass(0)).toBe('other')
  expect(describeError('plain')).toEqual({ name: 'Error', message: 'plain' })
  expect(describeError({ a: 1 })).toEqual({ name: 'Error', message: '{"a":1}' })
})

test('samples aggregate into window deltas and ship as one batch', async () => {
  const h = harness()
  h.telemetry.recordRequest({
    route: 'tasks.list',
    status: 200,
    durationMs: 12,
  })
  h.telemetry.recordRequest({
    route: 'tasks.list',
    status: 200,
    durationMs: 300,
  })
  h.telemetry.recordRequest({ route: 'tasks.list', status: 500, durationMs: 4 })
  h.telemetry.recordJob({
    type: 'sendDigest',
    kind: 'job',
    outcome: 'succeeded',
    durationMs: 700,
  })
  const error = new TypeError('boom')
  h.telemetry.captureException(error, {
    source: 'api',
    procedure: 'tasks.list',
    status: 500,
  })
  h.telemetry.captureException(error, {
    source: 'api',
    procedure: 'tasks.list',
    status: 500,
  })
  await h.telemetry.flush()
  expect(h.batches).toHaveLength(1)
  const [batch] = h.batches
  expect(h.requests[0]!.headers.get('authorization')).toBe('Bearer tok')
  expect(h.requests[0]!.url).toBe(
    'https://bunderhost.test/api/telemetry/v1/events',
  )
  expect(batch).toMatchObject({
    runtime: 'bunderstack',
    version: '0.27.0',
    release: 'rel1',
  })
  expect(batch!.errors).toEqual([
    expect.objectContaining({
      source: 'api',
      name: 'TypeError',
      message: 'boom',
      count: 2,
      context: { procedure: 'tasks.list', status: 500 },
    }),
  ])
  const metric = (name: string, labels: Record<string, string>) =>
    batch!.metrics.find(
      (m) =>
        m.name === name &&
        Object.entries(labels).every(([k, val]) => m.labels[k] === val),
    )?.value
  expect(
    metric('bh_app_requests', { route: 'tasks.list', status: '2xx' }),
  ).toBe(2)
  expect(
    metric('bh_app_requests', { route: 'tasks.list', status: '5xx' }),
  ).toBe(1)
  expect(
    metric('bh_app_request_duration_ms_bucket', {
      route: 'tasks.list',
      le: '25',
    }),
  ).toBe(2)
  expect(
    metric('bh_app_request_duration_ms_bucket', {
      route: 'tasks.list',
      le: '250',
    }),
  ).toBe(2)
  expect(
    metric('bh_app_request_duration_ms_bucket', {
      route: 'tasks.list',
      le: '+Inf',
    }),
  ).toBe(3)
  expect(
    metric('bh_app_request_duration_ms_sum', { route: 'tasks.list' }),
  ).toBe(316)
  expect(
    metric('bh_app_job_runs', {
      type: 'sendDigest',
      kind: 'job',
      outcome: 'succeeded',
    }),
  ).toBe(1)
  expect(
    metric('bh_app_job_duration_ms_bucket', { type: 'sendDigest', le: '1000' }),
  ).toBe(1)
  expect(metric('bh_app_errors', { source: 'api' })).toBe(2)
  // The window is empty afterwards: nothing to send.
  await h.telemetry.flush()
  expect(h.batches).toHaveLength(1)
})

test('flushIfDue waits for the window and a full error queue forces a send', async () => {
  const h = harness()
  h.telemetry.recordRequest({ route: 'a', status: 200, durationMs: 1 })
  await h.telemetry.flushIfDue()
  expect(h.batches).toHaveLength(0)
  h.advance(15_000)
  await h.telemetry.flushIfDue()
  expect(h.batches).toHaveLength(1)
  for (let i = 0; i < 50; i++)
    h.telemetry.captureException(new Error(`e${i}`), { source: 'job' })
  await h.telemetry.flushIfDue()
  expect(h.batches).toHaveLength(2)
  expect(h.batches[1]!.errors).toHaveLength(50)
})

test('a failing endpoint drops the window and warns once per five minutes', async () => {
  const h = harness({ fail: true })
  h.telemetry.recordRequest({ route: 'a', status: 200, durationMs: 1 })
  await h.telemetry.flush()
  h.telemetry.recordRequest({ route: 'a', status: 200, durationMs: 1 })
  await h.telemetry.flush()
  expect(h.logs.warnings).toHaveLength(1)
  expect(h.logs.warnings[0]!.message).toContain('telemetry not delivered')
  h.advance(5 * 60_000)
  h.telemetry.recordRequest({ route: 'a', status: 200, durationMs: 1 })
  await h.telemetry.flush()
  expect(h.logs.warnings).toHaveLength(2)
  const rejected = harness({ status: 401 })
  rejected.telemetry.recordRequest({ route: 'a', status: 200, durationMs: 1 })
  await rejected.telemetry.flush()
  expect(rejected.logs.warnings[0]!.message).toContain('answered 401')
})

test('route labels are capped and the noop sink does nothing', async () => {
  const h = harness()
  for (let i = 0; i < 510; i++)
    h.telemetry.recordRequest({ route: `r${i}`, status: 200, durationMs: 1 })
  await h.telemetry.flush()
  const routes = new Set(
    h.batches[0]!.metrics.filter((m) => m.name === 'bh_app_requests').map(
      (m) => m.labels.route,
    ),
  )
  expect(routes.size).toBe(501)
  expect(routes.has('other')).toBe(true)
  expect(noopTelemetry.enabled).toBe(false)
  noopTelemetry.captureException(new Error('x'), { source: 'api' })
  await noopTelemetry.flush()
})

test('the middleware times procedures and captures only unexpected failures', async () => {
  const h = harness()
  const base = os
    .$context<{
      request: Request
      peekSession: () => { user: unknown } | undefined
    }>()
    .use(telemetryMiddleware(h.telemetry) as never)
  const ok = base.handler(() => 'fine')
  const notFound = base.handler(() => {
    throw new ORPCError('NOT_FOUND', { message: 'no task' })
  })
  const crash = base.handler(() => {
    throw new TypeError('x is not a function')
  })
  const context = {
    request: new Request('https://shop.example/api/tasks/1?x=1', {
      method: 'POST',
    }),
    peekSession: () => ({ user: { id: 'u1' } }),
  }
  const { call } = await import('@orpc/server')
  expect(await call(ok, undefined, { context, path: ['tasks', 'list'] })).toBe(
    'fine',
  )
  await expect(
    call(notFound, undefined, { context, path: ['tasks', 'get'] }),
  ).rejects.toBeInstanceOf(ORPCError)
  await expect(
    call(crash, undefined, { context, path: ['tasks', 'complete'] }),
  ).rejects.toThrow('x is not a function')
  await h.telemetry.flush()
  const [batch] = h.batches
  expect(batch!.errors).toEqual([
    expect.objectContaining({
      source: 'api',
      name: 'TypeError',
      context: {
        procedure: 'tasks.complete',
        method: 'POST',
        path: '/api/tasks/1',
        status: 500,
        hasSession: true,
      },
    }),
  ])
  const requests = batch!.metrics.filter((m) => m.name === 'bh_app_requests')
  expect(requests).toContainEqual({
    name: 'bh_app_requests',
    labels: { route: 'tasks.list', status: '2xx' },
    value: 1,
  })
  expect(requests).toContainEqual({
    name: 'bh_app_requests',
    labels: { route: 'tasks.get', status: '4xx' },
    value: 1,
  })
  expect(requests).toContainEqual({
    name: 'bh_app_requests',
    labels: { route: 'tasks.complete', status: '5xx' },
    value: 1,
  })
})

test('process hooks report and exit only when nobody else listens', async () => {
  const h = harness()
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const exits: number[] = []
  const proc = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return proc
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      )
      return proc
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length
    },
    exit(code?: number) {
      exits.push(code ?? 0)
      return undefined as never
    },
  } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'listenerCount' | 'exit'>
  const uninstall = installProcessTelemetry(h.telemetry, proc)
  const originalError = console.error
  console.error = () => {}
  try {
    listeners.get('unhandledRejection')![0]!(new Error('nobody awaited'))
    await Bun.sleep(5)
    listeners.get('uncaughtException')![0]!(new Error('fatal'))
    await Bun.sleep(20)
  } finally {
    console.error = originalError
  }
  expect(exits).toEqual([1])
  expect(h.batches.flatMap((b) => b.errors.map((e) => e.message))).toEqual([
    'nobody awaited',
    'fatal',
  ])
  uninstall()
  expect(proc.listenerCount('uncaughtException')).toBe(0)
})

test('withTelemetry labels SSR requests by normalized path', async () => {
  const h = harness()
  const app = { telemetry: h.telemetry }
  const serve = withTelemetry(app, async (request) =>
    request.url.endsWith('/boom')
      ? Promise.reject(new Error('render failed'))
      : new Response('ok'),
  )
  expect(
    (
      await serve(
        new Request(
          'https://shop.example/projects/42/tasks/task_01hx4k3m9zq8r7t6y5w2v1n0pa',
        ),
      )
    ).status,
  ).toBe(200)
  await expect(serve(new Request('https://shop.example/boom'))).rejects.toThrow(
    'render failed',
  )
  await h.telemetry.flush()
  const requests = h.batches[0]!.metrics.filter(
    (m) => m.name === 'bh_app_requests',
  )
  expect(requests).toContainEqual({
    name: 'bh_app_requests',
    labels: { route: 'ssr /projects/:id/tasks/:id', status: '2xx' },
    value: 1,
  })
  expect(requests).toContainEqual({
    name: 'bh_app_requests',
    labels: { route: 'ssr /boom', status: '5xx' },
    value: 1,
  })
  expect(h.batches[0]!.errors[0]).toMatchObject({
    source: 'http',
    context: { method: 'GET', path: '/boom' },
  })
  expect(
    normalizePath('https://x/users/3fa85f64-5717-4562-b3fc-2c963f66afa6'),
  ).toBe('/users/:id')
  // Disabled telemetry wraps nothing.
  const passthrough = withTelemetry(
    { telemetry: noopTelemetry },
    async () => new Response('x'),
  )
  expect((await passthrough(new Request('https://x/'))).status).toBe(200)
})

test('a started application reports an API failure to the platform and stays silent without the variables', async () => {
  const received: Batch[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push((await request.json()) as Batch)
      return new Response(null, { status: 204 })
    },
  })
  const notes = sqliteTable('notes', { id: text('id').primaryKey() })
  const o = defineApi({ schema: { notes } })
  const api = {
    boom: o.public.route({ method: 'GET', path: '/api/boom' }).handler(() => {
      throw new Error('kaboom')
    }),
    refuse: o.public
      .route({ method: 'GET', path: '/api/refuse' })
      .handler(() => {
        throw new BunderstackError('NOT_FOUND', 'nothing here')
      }),
    fine: o.public
      .route({ method: 'GET', path: '/api/fine' })
      .input(v.optional(v.object({})))
      .handler(() => ({ ok: true })),
  }
  const backend = bunderstack({
    schema: { notes },
    database: { adapter: libsql() },
    api,
  })
  const app = await backend.start({
    env: {
      DATABASE_URL: ':memory:',
      BUNDERHOST_TELEMETRY_URL: `http://localhost:${server.port}/api/telemetry/v1`,
      BUNDERHOST_TELEMETRY_TOKEN: 'tok',
      BUNDERSTACK_REVISION: 'deadbeef',
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never)
  try {
    expect(app.telemetry.enabled).toBe(true)
    expect((await app.handler(new Request('http://app/api/fine'))).status).toBe(
      200,
    )
    expect(
      (await app.handler(new Request('http://app/api/refuse'))).status,
    ).toBe(404)
    expect((await app.handler(new Request('http://app/api/boom'))).status).toBe(
      500,
    )
    app.telemetry.captureException(new Error('handled by the app'), {
      source: 'api',
      procedure: 'manual',
    })
  } finally {
    await app.close()
  }
  try {
    expect(received).toHaveLength(1)
    const [batch] = received
    expect(batch).toMatchObject({ runtime: 'bunderstack', release: 'deadbeef' })
    expect(batch!.errors.map((e) => e.message).sort()).toEqual([
      'handled by the app',
      'kaboom',
    ])
    expect(batch!.errors.find((e) => e.message === 'kaboom')).toMatchObject({
      context: {
        procedure: 'boom',
        method: 'GET',
        path: '/api/boom',
        status: 500,
      },
    })
    const requests = batch!.metrics.filter((m) => m.name === 'bh_app_requests')
    expect(requests).toContainEqual({
      name: 'bh_app_requests',
      labels: { route: 'fine', status: '2xx' },
      value: 1,
    })
    expect(requests).toContainEqual({
      name: 'bh_app_requests',
      labels: { route: 'refuse', status: '4xx' },
      value: 1,
    })
    expect(requests).toContainEqual({
      name: 'bh_app_requests',
      labels: { route: 'boom', status: '5xx' },
      value: 1,
    })

    const silent = await bunderstack({
      schema: { notes },
      database: { adapter: libsql() },
      api,
    }).start({
      env: { DATABASE_URL: ':memory:' },
    })
    try {
      expect(silent.telemetry.enabled).toBe(false)
      expect(
        (await silent.handler(new Request('http://app/api/boom'))).status,
      ).toBe(500)
    } finally {
      await silent.close()
    }
    expect(received).toHaveLength(1)
  } finally {
    server.stop(true)
  }
})
